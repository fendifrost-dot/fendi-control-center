import { Link, Outlet } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

export function TaxShell() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border/80 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="container flex h-14 max-w-6xl items-center justify-between gap-4 px-4">
          <nav className="flex items-center gap-6">
            <Link to="/clients" className="text-lg font-semibold tracking-tight">
              Tax Prep
            </Link>
            <Link
              to="/clients"
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              Clients
            </Link>
            <Link
              to="/ops"
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              Ops
            </Link>
          </nav>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Toggle theme"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
          </Button>
        </div>
      </header>
      <main className="container max-w-6xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
