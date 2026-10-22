import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { HubCoverNav } from "./HubCoverNav";
import { HUB_TOOL_DEFS } from "@/lib/hubTools";

function CurrentPath() {
  return <output data-testid="current-path">{useLocation().pathname}</output>;
}

function openMenu() {
  render(
    <MemoryRouter>
      <HubCoverNav />
      <CurrentPath />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open tools menu" }));
  return screen.getByRole("dialog", { name: "Tools" });
}

describe("HubCoverNav", () => {
  it("keeps all tools and the final footer link in a bounded scroll region", () => {
    const dialog = openMenu();
    const scroll = within(dialog).getByTestId("tools-menu-scroll");
    expect(dialog).toHaveClass("flex", "h-[100dvh]", "flex-col", "overflow-hidden");
    expect(dialog).toHaveClass("pb-[max(1.5rem,env(safe-area-inset-bottom))]");
    expect(scroll).toHaveClass("min-h-0", "flex-1", "overflow-y-auto", "overscroll-y-contain");
    for (const tool of HUB_TOOL_DEFS) {
      expect(within(scroll).getByText(tool.name, { exact: true })).toBeInTheDocument();
    }
    expect(within(scroll).getByRole("link", { name: "Operator ops →" })).toHaveAttribute("href", "/ops");
    // The title and close control stay outside the long list.
    expect(scroll).not.toContainElement(within(dialog).getByRole("heading", { name: "Tools" }));
    expect(scroll).not.toContainElement(within(dialog).getByRole("button", { name: "Close" }));
  });

  it("offers the Message Board near the top, separate from Agent Hub", () => {
    const dialog = openMenu();
    const links = within(dialog).getAllByRole("link");
    const board = within(dialog).getByRole("link", { name: /Message Board/ });
    expect(links.indexOf(board)).toBeLessThan(3);
    expect(board).toHaveAttribute("href", "/muse/feed");
    expect(within(dialog).getByRole("link", { name: /^Agent Hub/ })).toHaveAttribute("href", "/agents");
  });

  it("opens the existing board route and closes the drawer", () => {
    const dialog = openMenu();
    fireEvent.click(within(dialog).getByRole("link", { name: /Message Board/ }));
    expect(screen.getByTestId("current-path")).toHaveTextContent("/muse/feed");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps footer navigation working and closes the drawer", () => {
    const dialog = openMenu();
    fireEvent.click(within(dialog).getByRole("link", { name: "Operator ops →" }));
    expect(screen.getByTestId("current-path")).toHaveTextContent("/ops");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("can close without navigating", () => {
    const dialog = openMenu();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("current-path")).toHaveTextContent("/");
  });
});
