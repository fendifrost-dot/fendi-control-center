import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { TaxShell } from "@/components/tax/TaxShell";
import Index from "./pages/Index";
import Ops from "./pages/Ops";
import Test from "./pages/Test";
import NotFound from "./pages/NotFound";
import ClientsPage from "./pages/tax/ClientsPage";
import ClientReturnsPage from "./pages/tax/ClientReturnsPage";
import YearWorkspacePage from "./pages/tax/YearWorkspacePage";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Index />} />
            <Route path="/ops" element={<Ops />} />
            <Route path="/test" element={<Test />} />
            <Route path="/tax" element={<Navigate to="/clients" replace />} />
            <Route path="/tax/*" element={<Navigate to="/clients" replace />} />
            <Route element={<TaxShell />}>
              <Route path="/clients" element={<ClientsPage />} />
              <Route path="/clients/:clientId" element={<ClientReturnsPage />} />
              <Route path="/clients/:clientId/:year" element={<YearWorkspacePage />} />
            </Route>
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </TooltipProvider>
    </ThemeProvider>
  </QueryClientProvider>
);

export default App;
