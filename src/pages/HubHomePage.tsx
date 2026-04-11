import { ToolGrid } from "@/components/hub/ToolGrid";

export default function HubHomePage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="container max-w-6xl px-4 py-8">
        <div className="space-y-8">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Fendi Control Hub</h1>
            <p className="mt-1 text-muted-foreground">Choose a tool to get started</p>
          </div>
          <ToolGrid />
        </div>
      </main>
    </div>
  );
}
