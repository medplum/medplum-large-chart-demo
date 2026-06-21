// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Button, Stack, Text, Title } from '@mantine/core';
import { AppShell, Document, ErrorBoundary, Loading, Logo, useMedplum, useMedplumProfile } from '@medplum/react';
import { Suspense } from 'react';
import type { JSX } from 'react';
import { Link, Route, Routes } from 'react-router';
import { LandingPage } from './pages/LandingPage';
import { SignInPage } from './pages/SignInPage';

export function App(): JSX.Element | null {
  const medplum = useMedplum();
  const profile = useMedplumProfile();

  if (medplum.isLoading()) {
    return null;
  }

  return (
    <AppShell logo={<Logo size={24} />}>
      <ErrorBoundary>
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/" element={profile ? <HomePage /> : <LandingPage />} />
            <Route path="/signin" element={<SignInPage />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </AppShell>
  );
}

function HomePage(): JSX.Element {
  return (
    <Document width={600}>
      <Stack>
        <Title order={1}>Medplum Large Chart Demo</Title>
        <Text c="dimmed">Authenticated Medplum app shell is ready for the large chart demo.</Text>
        <Button component={Link} to="/signin" variant="light">
          Switch account
        </Button>
      </Stack>
    </Document>
  );
}
