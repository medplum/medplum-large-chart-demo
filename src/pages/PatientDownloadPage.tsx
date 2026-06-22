// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Badge, Button, Group, Progress, SimpleGrid, Stack, Table, Text, Title } from '@mantine/core';
import { normalizeErrorString } from '@medplum/core';
import type { HumanName, Patient } from '@medplum/fhirtypes';
import { Document, Loading, useMedplum } from '@medplum/react';
import type { JSX } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import {
  downloadPatientChart,
  formatBytes,
  formatDuration,
  isDownloadMode,
} from '../lib/patientDownload';
import type { DownloadMode, DownloadProgress } from '../lib/patientDownload';

const MODE_DETAILS: Record<DownloadMode, { readonly title: string; readonly description: string }> = {
  everything: {
    title: 'Patient/$everything',
    description: 'Uses the FHIR Patient $everything operation with paginated Bundle responses.',
  },
  bulk: {
    title: 'Group/$export',
    description: 'Creates a temporary one-patient Group, starts patient-scoped bulk export, and downloads NDJSON files.',
  },
  search: {
    title: 'Naive FHIR search',
    description: 'Runs paginated REST searches across patient-compartment resource types.',
  },
  graphql: {
    title: 'FHIR $graphql',
    description: 'Runs paginated GraphQL list queries across patient-compartment resource types.',
  },
};

export function PatientDownloadPage(): JSX.Element {
  const medplum = useMedplum();
  const params = useParams();
  const mode = params.mode;
  const patientId = params.id;
  const [patient, setPatient] = useState<Patient>();
  const [patientError, setPatientError] = useState<string>();
  const [progress, setProgress] = useState<DownloadProgress>();
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!patientId) {
      return undefined;
    }
    medplum
      .readResource('Patient', patientId)
      .then(setPatient)
      .catch((err: unknown) => setPatientError(normalizeErrorString(err)));
    return undefined;
  }, [medplum, patientId]);

  useEffect(() => {
    if (!patientId || !isDownloadMode(mode)) {
      return undefined;
    }

    const controller = new AbortController();
    downloadPatientChart(mode, medplum, {
      patientId,
      signal: controller.signal,
      onProgress: setProgress,
    }).catch((err: unknown) => {
      if (controller.signal.aborted) {
        return;
      }
      setProgress((current) => ({
        method: MODE_DETAILS[mode].title,
        stage: 'Failed',
        pages: current?.pages ?? 0,
        resources: current?.resources ?? 0,
        bytes: current?.bytes ?? 0,
        started: current?.started ?? Date.now(),
        finished: Date.now(),
        resourceCounts: current?.resourceCounts ?? {},
        error: normalizeErrorString(err),
      }));
    });

    return () => controller.abort();
  }, [medplum, mode, patientId]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(interval);
  }, []);

  if (!patientId || !isDownloadMode(mode)) {
    return <Navigate to="/" replace />;
  }

  const details = MODE_DETAILS[mode];
  const elapsed = progress ? (progress.finished ?? now) - progress.started : 0;
  const isComplete = progress?.stage === 'Complete';
  const isFailed = Boolean(progress?.error);
  const status = getStatus(isComplete, isFailed);

  return (
    <Document width={1100}>
      <Stack gap="lg">
        <Group justify="space-between" align="flex-start">
          <Stack gap={4}>
            <Button component={Link} to="/" variant="subtle" px={0}>
              Back to patients
            </Button>
            <Title order={1}>{details.title}</Title>
            <Text c="dimmed">{details.description}</Text>
          </Stack>
          <Badge color={status.color} variant="light" size="lg">
            {status.label}
          </Badge>
        </Group>

        <PatientSummary patient={patient} patientId={patientId} error={patientError} />

        <Stack gap="sm">
          <Group justify="space-between">
            <Text fw={600}>{progress?.stage ?? 'Starting download'}</Text>
            <Text c="dimmed">{formatDuration(elapsed)}</Text>
          </Group>
          <Progress value={isComplete || isFailed ? 100 : 50} animated={!isComplete && !isFailed} />
        </Stack>

        <SimpleGrid cols={{ base: 2, sm: 4 }}>
          <Metric label="Pages/files" value={progress?.pages.toLocaleString() ?? '0'} />
          <Metric label="Resources" value={progress?.resources.toLocaleString() ?? '0'} />
          <Metric label="Bytes" value={formatBytes(progress?.bytes ?? 0)} />
          <Metric label="Elapsed" value={formatDuration(elapsed)} />
        </SimpleGrid>

        {progress?.error && (
          <Text c="red" fw={600}>
            {progress.error}
          </Text>
        )}

        <ResourceCountsTable progress={progress} />
      </Stack>
    </Document>
  );
}

function getStatus(isComplete: boolean, isFailed: boolean): { readonly label: string; readonly color: string } {
  if (isFailed) {
    return { label: 'Failed', color: 'red' };
  }
  if (isComplete) {
    return { label: 'Complete', color: 'green' };
  }
  return { label: 'Running', color: 'blue' };
}

interface PatientSummaryProps {
  readonly patient: Patient | undefined;
  readonly patientId: string;
  readonly error: string | undefined;
}

function PatientSummary(props: PatientSummaryProps): JSX.Element {
  const { error, patient, patientId } = props;
  if (error) {
    return <Text c="red">Could not load Patient/{patientId}: {error}</Text>;
  }
  if (!patient) {
    return <Loading />;
  }
  return (
    <SimpleGrid cols={{ base: 1, sm: 4 }}>
      <Metric label="Patient" value={formatPatientName(patient.name) || patientId} />
      <Metric label="FHIR id" value={patientId} />
      <Metric label="Birth date" value={patient.birthDate ?? 'Unknown'} />
      <Metric label="Gender" value={patient.gender ?? 'Unknown'} />
    </SimpleGrid>
  );
}

interface MetricProps {
  readonly label: string;
  readonly value: string;
}

function Metric(props: MetricProps): JSX.Element {
  return (
    <Stack gap={2} p="sm" bg="gray.0" style={{ border: '1px solid var(--mantine-color-gray-3)', borderRadius: 6 }}>
      <Text size="xs" c="dimmed" tt="uppercase">
        {props.label}
      </Text>
      <Text fw={600}>{props.value}</Text>
    </Stack>
  );
}

function ResourceCountsTable(props: { readonly progress: DownloadProgress | undefined }): JSX.Element {
  const rows = useMemo(
    () =>
      Object.entries(props.progress?.resourceCounts ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    [props.progress?.resourceCounts]
  );

  return (
    <Table striped withTableBorder withColumnBorders>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Resource type</Table.Th>
          <Table.Th>Count</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.length === 0 ? (
          <Table.Tr>
            <Table.Td colSpan={2}>
              <Text c="dimmed">No resources counted yet.</Text>
            </Table.Td>
          </Table.Tr>
        ) : (
          rows.map(([resourceType, count]) => (
            <Table.Tr key={resourceType}>
              <Table.Td>{resourceType}</Table.Td>
              <Table.Td>{count.toLocaleString()}</Table.Td>
            </Table.Tr>
          ))
        )}
      </Table.Tbody>
    </Table>
  );
}

function formatPatientName(names: HumanName[] | undefined): string {
  const name = names?.[0];
  if (!name) {
    return '';
  }
  return name.text ?? [...(name.given ?? []), name.family].filter(Boolean).join(' ');
}
