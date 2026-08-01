import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Menu, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function MobileNav() {
  const [isOpen, setIsOpen] = useState(false)
  return (
    <div className="sm:hidden">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setIsOpen(!isOpen)}
        className="h-9 w-9"
      >
        {isOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
        <span className="sr-only">Toggle menu</span>
      </Button>

      {isOpen && (
        <div className="bg-popover border-border absolute top-16 right-0 left-0 z-50 border shadow-xl">
          <div className="container mx-auto px-4 py-4">
            <div className="flex flex-col space-y-4">
              <Link
                to="/"
                className="text-popover-foreground hover:text-primary [&.active]:text-primary py-2 transition-colors [&.active]:font-medium"
                onClick={() => setIsOpen(false)}
              >
                Home
              </Link>
              <Link
                to="/about"
                className="text-popover-foreground hover:text-primary [&.active]:text-primary py-2 transition-colors [&.active]:font-medium"
                onClick={() => setIsOpen(false)}
              >
                About
              </Link>
              <Link
                to="/features"
                className="text-popover-foreground hover:text-primary [&.active]:text-primary py-2 transition-colors [&.active]:font-medium"
                onClick={() => setIsOpen(false)}
              >
                Features
              </Link>
              <Link
                to="/traceback"
                className="text-popover-foreground hover:text-primary [&.active]:text-primary py-2 transition-colors [&.active]:font-medium"
                onClick={() => setIsOpen(false)}
              >
                Traceback
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
