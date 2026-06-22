// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';
import type { Bundle, BundleLink, Group, Resource, ResourceType } from '@medplum/fhirtypes';

export type DownloadMode = 'everything' | 'bulk' | 'search' | 'graphql';

export interface DownloadProgress {
  readonly method: string;
  readonly stage: string;
  readonly pages: number;
  readonly resources: number;
  readonly bytes: number;
  readonly started: number;
  readonly finished?: number;
  readonly resourceCounts: Record<string, number>;
  readonly error?: string;
}

interface DownloadOptions {
  readonly patientId: string;
  readonly count: number;
  readonly pollIntervalMs: number;
  readonly maxPolls: number;
  readonly onProgress: (progress: DownloadProgress) => void;
  readonly signal: AbortSignal;
}

interface BulkDataResponse {
  readonly output?: BulkDataOutput[];
}

interface BulkDataOutput {
  readonly type: ResourceType;
  readonly url: string;
}

interface JsonResponse<T> {
  readonly value: T;
  readonly text: string;
  readonly bytes: number;
}

interface SearchTarget {
  readonly resourceType: ResourceType;
  readonly searchParam: string;
  readonly value: string;
}

type MutableProgress = {
  method: string;
  stage: string;
  pages: number;
  resources: number;
  bytes: number;
  started: number;
  finished?: number;
  resourceCounts: Record<string, number>;
  error?: string;
};

const DEFAULT_COUNT = 1000;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_MAX_POLLS = 600;

const PATIENT_COMPARTMENT_SEARCH_TARGETS: SearchTarget[] = [
  { resourceType: 'Patient', searchParam: '_id', value: '' },
  { resourceType: 'RelatedPerson', searchParam: 'patient', value: '' },
  { resourceType: 'Coverage', searchParam: 'beneficiary', value: '' },
  { resourceType: 'Encounter', searchParam: 'subject', value: '' },
  { resourceType: 'Appointment', searchParam: 'actor', value: '' },
  { resourceType: 'Condition', searchParam: 'subject', value: '' },
  { resourceType: 'AllergyIntolerance', searchParam: 'patient', value: '' },
  { resourceType: 'FamilyMemberHistory', searchParam: 'patient', value: '' },
  { resourceType: 'MedicationRequest', searchParam: 'subject', value: '' },
  { resourceType: 'Observation', searchParam: 'subject', value: '' },
  { resourceType: 'DiagnosticReport', searchParam: 'subject', value: '' },
  { resourceType: 'Specimen', searchParam: 'subject', value: '' },
  { resourceType: 'ImagingStudy', searchParam: 'subject', value: '' },
  { resourceType: 'Procedure', searchParam: 'subject', value: '' },
  { resourceType: 'Immunization', searchParam: 'patient', value: '' },
  { resourceType: 'ServiceRequest', searchParam: 'subject', value: '' },
  { resourceType: 'Goal', searchParam: 'patient', value: '' },
  { resourceType: 'CarePlan', searchParam: 'subject', value: '' },
  { resourceType: 'CareTeam', searchParam: 'subject', value: '' },
  { resourceType: 'DocumentReference', searchParam: 'patient', value: '' },
  { resourceType: 'ClinicalImpression', searchParam: 'subject', value: '' },
  { resourceType: 'QuestionnaireResponse', searchParam: 'subject', value: '' },
  { resourceType: 'Communication', searchParam: 'subject', value: '' },
  { resourceType: 'Consent', searchParam: 'patient', value: '' },
  { resourceType: 'Flag', searchParam: 'patient', value: '' },
  { resourceType: 'List', searchParam: 'subject', value: '' },
];

export async function downloadPatientChart(
  mode: DownloadMode,
  medplum: MedplumClient,
  options: Partial<DownloadOptions> & Pick<DownloadOptions, 'patientId' | 'onProgress' | 'signal'>
): Promise<DownloadProgress> {
  const resolvedOptions: DownloadOptions = {
    count: DEFAULT_COUNT,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    maxPolls: DEFAULT_MAX_POLLS,
    ...options,
  };

  switch (mode) {
    case 'everything':
      return downloadEverything(medplum, resolvedOptions);
    case 'bulk':
      return downloadBulkExport(medplum, resolvedOptions);
    case 'search':
      return downloadSearch(medplum, resolvedOptions);
    case 'graphql':
      return downloadGraphql(medplum, resolvedOptions);
  }
  throw new Error(`Unsupported download mode: ${mode}`);
}

export function isDownloadMode(value: string | undefined): value is DownloadMode {
  return value === 'everything' || value === 'bulk' || value === 'search' || value === 'graphql';
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(2)} sec`;
}

async function downloadEverything(medplum: MedplumClient, options: DownloadOptions): Promise<DownloadProgress> {
  const progress = createProgress('Patient/$everything');
  let nextUrl: URL | undefined = medplum.fhirUrl('Patient', options.patientId, '$everything');
  nextUrl.searchParams.set('_count', String(options.count));

  while (nextUrl) {
    throwIfAborted(options.signal);
    updateStage(progress, options, 'Downloading $everything bundle pages');
    const { value: bundle, bytes } = await getJson<Bundle>(medplum, nextUrl, options.signal);
    progress.bytes += bytes;
    recordBundle(progress, bundle);
    progress.pages++;
    emit(progress, options);
    nextUrl = getNextUrl(medplum, bundle);
  }

  return finish(progress, options);
}

async function downloadBulkExport(medplum: MedplumClient, options: DownloadOptions): Promise<DownloadProgress> {
  const progress = createProgress('Group/$export');
  const group = await createBulkExportGroup(medplum, options.patientId);
  try {
    updateStage(progress, options, `Created temporary Group/${group.id}`);
    const accessToken = medplum.getAccessToken();
    if (!accessToken) {
      throw new Error('No Medplum access token available for bulk export');
    }

    const kickoffResponse = await fetch(medplum.fhirUrl('Group', group.id as string, '$export'), {
      method: 'POST',
      headers: {
        Prefer: 'respond-async',
        Authorization: `Bearer ${accessToken}`,
      },
      signal: options.signal,
    });
    if (kickoffResponse.status !== 202) {
      throw new Error(`Bulk export kickoff failed: ${kickoffResponse.status} ${await kickoffResponse.text()}`);
    }

    const contentLocation = kickoffResponse.headers.get('content-location');
    if (!contentLocation) {
      throw new Error('Bulk export kickoff did not return Content-Location');
    }

    updateStage(progress, options, 'Polling bulk export status');
    const bulkResponse = await pollBulkExport(contentLocation, medplum, options);
    progress.bytes += byteLength(JSON.stringify(bulkResponse));
    emit(progress, options);

    for (const output of bulkResponse.output ?? []) {
      throwIfAborted(options.signal);
      updateStage(progress, options, `Downloading ${output.type}.ndjson`);
      const response = await medplum.downloadResponse(output.url, { signal: options.signal });
      if (!response.ok) {
        throw new Error(`Bulk export download failed for ${output.url}: ${response.status} ${await response.text()}`);
      }
      const text = await response.text();
      const count = countNdjsonLines(text);
      progress.bytes += byteLength(text);
      progress.pages++;
      progress.resources += count;
      progress.resourceCounts[output.type] = (progress.resourceCounts[output.type] ?? 0) + count;
      emit(progress, options);
    }

    return finish(progress, options);
  } finally {
    await deleteTemporaryGroup(medplum, group);
  }
}

async function downloadSearch(medplum: MedplumClient, options: DownloadOptions): Promise<DownloadProgress> {
  const progress = createProgress('Naive FHIR search');
  for (const target of getSearchTargets(options.patientId)) {
    let nextUrl: URL | undefined = medplum.fhirSearchUrl(target.resourceType, {
      [target.searchParam]: target.value,
      _count: String(options.count),
      _sort: '_lastUpdated',
    });

    while (nextUrl) {
      throwIfAborted(options.signal);
      updateStage(progress, options, `Searching ${target.resourceType}`);
      const { value: bundle, bytes } = await getJson<Bundle>(medplum, nextUrl, options.signal);
      progress.bytes += bytes;
      recordBundle(progress, bundle);
      progress.pages++;
      emit(progress, options);
      nextUrl = getNextUrl(medplum, bundle);
    }
  }
  return finish(progress, options);
}

async function downloadGraphql(medplum: MedplumClient, options: DownloadOptions): Promise<DownloadProgress> {
  const progress = createProgress('FHIR $graphql');
  for (const target of getSearchTargets(options.patientId)) {
    let lastUpdated: string | undefined = undefined;
    while (true) {
      throwIfAborted(options.signal);
      updateStage(progress, options, `Querying ${target.resourceType}List`);
      const query = buildGraphqlQuery(target, options.count, lastUpdated);
      const { value: result, bytes } = await postGraphql(medplum, query, options.signal);
      const resources = readGraphqlList(result, target.resourceType);
      progress.bytes += bytes;
      progress.pages++;
      progress.resources += resources.length;
      progress.resourceCounts[target.resourceType] = (progress.resourceCounts[target.resourceType] ?? 0) + resources.length;
      emit(progress, options);
      if (resources.length < options.count) {
        break;
      }
      const nextLastUpdated = getLastUpdated(resources);
      if (!nextLastUpdated || nextLastUpdated === lastUpdated) {
        throw new Error(`Could not advance GraphQL pagination for ${target.resourceType}`);
      }
      lastUpdated = nextLastUpdated;
    }
  }
  return finish(progress, options);
}

async function pollBulkExport(
  contentLocation: string,
  medplum: MedplumClient,
  options: DownloadOptions
): Promise<BulkDataResponse> {
  const accessToken = medplum.getAccessToken();
  if (!accessToken) {
    throw new Error('No Medplum access token available for bulk export polling');
  }

  for (let i = 0; i < options.maxPolls; i++) {
    throwIfAborted(options.signal);
    const response = await fetch(contentLocation, {
      headers: {
        Accept: 'application/fhir+json',
        Authorization: `Bearer ${accessToken}`,
      },
      signal: options.signal,
    });
    if (response.status === 202) {
      const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
      await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : options.pollIntervalMs, options.signal);
      continue;
    }
    if (!response.ok) {
      throw new Error(`Bulk export status failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as BulkDataResponse;
  }
  throw new Error(`Bulk export did not complete after ${options.maxPolls} polls`);
}

async function createBulkExportGroup(medplum: MedplumClient, patientId: string): Promise<Group> {
  const group = await medplum.createResource<Group>({
    resourceType: 'Group',
    active: true,
    type: 'person',
    actual: true,
    name: `Temporary bulk export group for Patient/${patientId}`,
    quantity: 1,
    member: [{ entity: { reference: `Patient/${patientId}` } }],
  });
  if (!group.id) {
    throw new Error('Temporary bulk export Group was created without an id');
  }
  return group;
}

async function deleteTemporaryGroup(medplum: MedplumClient, group: Group): Promise<void> {
  if (group.id) {
    await medplum.deleteResource('Group', group.id);
  }
}

async function getJson<T>(medplum: MedplumClient, url: URL, signal: AbortSignal): Promise<JsonResponse<T>> {
  const response = await medplum.downloadResponse(url, { headers: { Accept: 'application/fhir+json' }, signal });
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${await response.text()}`);
  }
  const text = await response.text();
  return { value: JSON.parse(text) as T, text, bytes: byteLength(text) };
}

async function postGraphql(medplum: MedplumClient, query: string, signal: AbortSignal): Promise<JsonResponse<any>> {
  const response = await medplum.downloadResponse(medplum.fhirUrl('$graphql'), {
    method: 'POST',
    headers: { Accept: 'application/fhir+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`FHIR $graphql failed: ${response.status} ${await response.text()}`);
  }
  const text = await response.text();
  const value = JSON.parse(text);
  if (value.errors?.length) {
    throw new Error(`FHIR $graphql returned errors: ${JSON.stringify(value.errors)}`);
  }
  return { value, text, bytes: byteLength(text) };
}

function buildGraphqlQuery(target: SearchTarget, count: number, lastUpdated: string | undefined): string {
  const args = [`_count: ${count}`, `_sort: "_lastUpdated"`, `${target.searchParam}: ${JSON.stringify(target.value)}`];
  if (lastUpdated) {
    args.push(`_lastUpdated: "gt${lastUpdated}"`);
  }
  return `{
    ${target.resourceType}List(${args.join(', ')}) {
      ${getGraphqlSelection(target.resourceType)}
    }
  }`;
}

function getGraphqlSelection(resourceType: ResourceType): string {
  const base = `
    id
    meta {
      lastUpdated
    }
  `;
  const reference = `
    reference
    display
  `;
  const codeableConcept = `
    text
    coding {
      system
      code
      display
    }
  `;
  const quantity = `
    value
    unit
    system
    code
  `;
  const period = `
    start
    end
  `;
  const humanName = `
    use
    given
    family
    text
  `;

  switch (resourceType) {
    case 'Patient':
      return `${base}
        name { ${humanName} }
        gender
        birthDate`;
    case 'RelatedPerson':
      return `${base}
        patient { ${reference} }
        relationship { ${codeableConcept} }
        name { ${humanName} }
        telecom {
          system
          value
          use
        }`;
    case 'Coverage':
      return `${base}
        status
        beneficiary { ${reference} }
        payor { ${reference} }
        class {
          type { ${codeableConcept} }
          value
          name
        }`;
    case 'Encounter':
      return `${base}
        status
        class { system code display }
        type { ${codeableConcept} }
        subject { ${reference} }
        participant {
          individual { ${reference} }
        }
        period { ${period} }
        serviceProvider { ${reference} }
        location {
          location { ${reference} }
        }`;
    case 'Appointment':
      return `${base}
        status
        appointmentType { ${codeableConcept} }
        start
        end
        participant {
          actor { ${reference} }
          status
        }`;
    case 'Condition':
      return `${base}
        clinicalStatus { ${codeableConcept} }
        verificationStatus { ${codeableConcept} }
        code { ${codeableConcept} }
        subject { ${reference} }
        encounter { ${reference} }
        recordedDate
        recorder { ${reference} }`;
    case 'AllergyIntolerance':
      return `${base}
        clinicalStatus { ${codeableConcept} }
        verificationStatus { ${codeableConcept} }
        code { ${codeableConcept} }
        patient { ${reference} }
        encounter { ${reference} }
        recordedDate
        recorder { ${reference} }`;
    case 'FamilyMemberHistory':
      return `${base}
        status
        patient { ${reference} }
        date
        relationship { ${codeableConcept} }
        condition {
          code { ${codeableConcept} }
        }`;
    case 'MedicationRequest':
      return `${base}
        status
        intent
        medicationReference { ${reference} }
        subject { ${reference} }
        encounter { ${reference} }
        authoredOn
        requester { ${reference} }
        dosageInstruction {
          text
          patientInstruction
          route { ${codeableConcept} }
          doseAndRate {
            doseQuantity { ${quantity} }
          }
        }`;
    case 'Observation':
      return `${base}
        status
        category { ${codeableConcept} }
        code { ${codeableConcept} }
        subject { ${reference} }
        encounter { ${reference} }
        effectiveDateTime
        performer { ${reference} }
        specimen { ${reference} }
        valueQuantity { value unit system code }
        valueString
        valueBoolean
        valueInteger
        valueDateTime`;
    case 'DiagnosticReport':
      return `${base}
        status
        category { ${codeableConcept} }
        code { ${codeableConcept} }
        subject { ${reference} }
        effectiveDateTime
        performer { ${reference} }
        result { ${reference} }`;
    case 'Specimen':
      return `${base}
        status
        type { ${codeableConcept} }
        subject { ${reference} }
        collection {
          collectedDateTime
          collector { ${reference} }
        }`;
    case 'ImagingStudy':
      return `${base}
        status
        subject { ${reference} }
        encounter { ${reference} }
        started
        numberOfSeries
        numberOfInstances
        series {
          uid
          modality {
            system
            code
            display
          }
          numberOfInstances
        }`;
    case 'Procedure':
      return `${base}
        status
        code { ${codeableConcept} }
        subject { ${reference} }
        encounter { ${reference} }
        performedDateTime
        performer {
          actor { ${reference} }
        }`;
    case 'Immunization':
      return `${base}
        status
        vaccineCode { ${codeableConcept} }
        patient { ${reference} }
        encounter { ${reference} }
        occurrenceDateTime
        primarySource`;
    case 'ServiceRequest':
      return `${base}
        status
        intent
        code { ${codeableConcept} }
        subject { ${reference} }
        encounter { ${reference} }
        requester { ${reference} }
        performer { ${reference} }
        authoredOn`;
    case 'Goal':
      return `${base}
        lifecycleStatus
        description { ${codeableConcept} }
        subject { ${reference} }
        startDate
        expressedBy { ${reference} }`;
    case 'CarePlan':
      return `${base}
        status
        intent
        title
        subject { ${reference} }
        encounter { ${reference} }
        period { ${period} }
        goal { ${reference} }`;
    case 'CareTeam':
      return `${base}
        status
        name
        subject { ${reference} }
        encounter { ${reference} }
        participant {
          member { ${reference} }
        }`;
    case 'DocumentReference':
      return `${base}
        status
        type { ${codeableConcept} }
        subject { ${reference} }
        date
        author { ${reference} }
        context {
          encounter { ${reference} }
        }
        content {
          attachment {
            contentType
            title
            url
            size
          }
        }`;
    case 'ClinicalImpression':
      return `${base}
        status
        description
        subject { ${reference} }
        encounter { ${reference} }
        effectiveDateTime
        date
        assessor { ${reference} }
        summary`;
    case 'QuestionnaireResponse':
      return `${base}
        status
        questionnaire
        subject { ${reference} }
        encounter { ${reference} }
        authored
        author { ${reference} }
        item {
          linkId
          text
          answer {
            valueString
            valueBoolean
            valueInteger
            valueDecimal
            valueDate
            valueDateTime
            valueQuantity { ${quantity} }
            valueCoding {
              system
              code
              display
            }
          }
        }`;
    case 'Communication':
      return `${base}
        status
        category { ${codeableConcept} }
        subject { ${reference} }
        encounter { ${reference} }
        sent
        recipient { ${reference} }
        sender { ${reference} }
        payload {
          contentString
          contentAttachment {
            contentType
            title
            url
            size
          }
        }`;
    case 'Consent':
      return `${base}
        status
        scope { ${codeableConcept} }
        category { ${codeableConcept} }
        patient { ${reference} }
        dateTime
        performer { ${reference} }`;
    case 'Flag':
      return `${base}
        status
        category { ${codeableConcept} }
        code { ${codeableConcept} }
        subject { ${reference} }
        period { ${period} }`;
    case 'List':
      return `${base}
        status
        mode
        title
        code { ${codeableConcept} }
        subject { ${reference} }
        date
        entry {
          item { ${reference} }
        }`;
    default:
      return base;
  }
}

function readGraphqlList(result: any, resourceType: ResourceType): Resource[] {
  const list = result?.data?.[`${resourceType}List`];
  if (!Array.isArray(list)) {
    throw new Error(`GraphQL response did not include data.${resourceType}List array`);
  }
  return list as Resource[];
}

function getLastUpdated(resources: Resource[]): string | undefined {
  const last = resources.at(-1);
  return typeof last?.meta?.lastUpdated === 'string' ? last.meta.lastUpdated : undefined;
}

function getSearchTargets(patientId: string): SearchTarget[] {
  return PATIENT_COMPARTMENT_SEARCH_TARGETS.map((target) => ({
    ...target,
    value: target.resourceType === 'Patient' ? patientId : `Patient/${patientId}`,
  }));
}

function getNextUrl(medplum: MedplumClient, bundle: Bundle): URL | undefined {
  const nextLink: BundleLink | undefined = bundle.link?.find((link) => link.relation === 'next');
  return nextLink?.url ? new URL(nextLink.url, medplum.getBaseUrl()) : undefined;
}

function recordBundle(progress: MutableProgress, bundle: Bundle): void {
  for (const entry of bundle.entry ?? []) {
    const resource = entry.resource;
    if (!resource?.resourceType) {
      continue;
    }
    progress.resources++;
    progress.resourceCounts[resource.resourceType] = (progress.resourceCounts[resource.resourceType] ?? 0) + 1;
  }
}

function countNdjsonLines(text: string): number {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean).length;
}

function createProgress(method: string): MutableProgress {
  return {
    method,
    stage: 'Starting',
    pages: 0,
    resources: 0,
    bytes: 0,
    started: Date.now(),
    resourceCounts: {},
  };
}

function updateStage(progress: MutableProgress, options: DownloadOptions, stage: string): void {
  progress.stage = stage;
  emit(progress, options);
}

function finish(progress: MutableProgress, options: DownloadOptions): DownloadProgress {
  progress.finished = Date.now();
  progress.stage = 'Complete';
  emit(progress, options);
  return toProgress(progress);
}

function emit(progress: MutableProgress, options: DownloadOptions): void {
  options.onProgress(toProgress(progress));
}

function toProgress(progress: MutableProgress): DownloadProgress {
  return {
    ...progress,
    resourceCounts: { ...progress.resourceCounts },
  };
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timeout = window.setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timeout);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true }
    );
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}
