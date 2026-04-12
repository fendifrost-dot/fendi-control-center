import { MatrixRain } from "@/components/hub/MatrixRain";
import { HubCoverNav } from "@/components/hub/HubCoverNav";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme } from "next-themes";

export default function HubHomePage() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="relative min-h-screen overflow-hidden bg-black text-green-100">
      <MatrixRain />
      <div className="relative z-10 flex min-h-screen flex-col">
        <header className="flex items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <h1 className="font-mono text-base font-bold tracking-[0.2em] text-green-400 drop-shadow-[0_0_8px_rgba(0,255,65,0.35)] sm:text-lg">
            FENDI CONTROL CENTER
          </h1>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="text-green-500/90 hover:bg-green-950/50 hover:text-green-300"
              aria-label="Toggle theme"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
            </Button>
            <HubCoverNav />
          </div>
        </header>
        <main className="flex flex-1" />
      </div>
    </div>
  );
}
