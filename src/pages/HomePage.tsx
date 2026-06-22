// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Group, SegmentedControl, Stack, Text, Title } from '@mantine/core';
import type { SearchRequest } from '@medplum/core';
import type { Patient } from '@medplum/fhirtypes';
import { Document, SearchControl } from '@medplum/react';
import type { JSX } from 'react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { DownloadMode } from '../lib/patientDownload';

const PATIENT_SEARCH: SearchRequest<Patient> = {
  resourceType: 'Patient',
  fields: ['name', 'birthDate', 'gender'],
  count: 20,
};

export function HomePage(): JSX.Element {
  const navigate = useNavigate();
  const [mode, setMode] = useState<DownloadMode>('everything');

  return (
    <Document width={1100}>
      <Stack gap="lg">
        <Group justify="space-between" align="flex-end">
          <Stack gap={4}>
            <Title order={1}>Medplum Large Chart Demo</Title>
            <Text c="dimmed">Select a download method, then choose a patient chart to load.</Text>
          </Stack>
          <SegmentedControl
            value={mode}
            onChange={(value) => setMode(value as DownloadMode)}
            data={[
              { label: '$everything', value: 'everything' },
              { label: 'Bulk export', value: 'bulk' },
              { label: 'Search', value: 'search' },
              { label: '$graphql', value: 'graphql' },
            ]}
          />
        </Group>

        <SearchControl
          search={PATIENT_SEARCH}
          hideFilters={false}
          onClick={(e) => {
            e.browserEvent.preventDefault();
            navigate(`/demo/${mode}/Patient/${e.resource.id}`)?.catch(console.error);
          }}
        />
      </Stack>
    </Document>
  );
}
