import { createFileRoute } from '@tanstack/react-router'

import { TracebackPage } from '@/components/traceback/traceback-page'

export const Route = createFileRoute('/traceback')({
  component: TracebackPage,
})
