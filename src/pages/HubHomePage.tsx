import { ToolGrid } from "@/components/hub/ToolGrid";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme } from "next-themes";

export default function HubHomePage() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border/80 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="container flex h-14 max-w-6xl items-center justify-between gap-4 px-4">
          <h1 className="text-lg font-semibold tracking-tight">Fendi Control Hub</h1>
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
        <p className="mb-6 text-muted-foreground">Choose a tool to get started</p>
        <ToolGrid />
      </main>
    </div>
  );
}
