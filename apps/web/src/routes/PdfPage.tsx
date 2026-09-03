import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams, useNavigate } from '@tanstack/react-router';
import type { Project } from '@latex-workshop/contracts';
import { authClient } from '../lib/auth';
import { PdfViewer } from '../features/pdf/PdfViewer';
import { api, appPath, queryKeys } from '../lib/api';

type ProjectPayload = { project: Project };

export default function PdfPage() {
  const { projectId, jobId } = useParams({ from: '/projects/$projectId/pdf/$jobId' });
  const navigate = useNavigate();
  const { data: session, isPending } = authClient.useSession();
  const project = useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: () => api<ProjectPayload>(`/api/v1/projects/${projectId}`),
    enabled: Boolean(session?.user),
  });
  useEffect(() => {
    if (!isPending && !session?.user) void navigate({ to: '/auth' });
  }, [session, isPending, navigate]);
  useEffect(() => {
    if (!project.data) return;
    document.title = `${project.data.project.name} — PDF | LaTeX Workshop`;
    return () => {
      document.title = 'LaTeX Workshop';
    };
  }, [project.data]);
  if (!session?.user)
    return (
      <main className="screen-center">
        <span className="spinner" />
      </main>
    );
  const url = appPath(`/api/v1/projects/${projectId}/compilations/${jobId}/pdf`);
  return (
    <main style={{ height: '100%' }}>
      <PdfViewer
        url={url}
        downloadUrl={appPath(`/api/v1/projects/${projectId}/compilations/${jobId}/download`)}
      />
    </main>
  );
}
