import { createFileRoute } from '@tanstack/react-router'

import { HomePage } from '@/components/traceback/home-page'

export const Route = createFileRoute('/')({
  component: HomePage,
})
