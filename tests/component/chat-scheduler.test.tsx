import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatScheduler } from "@/components/chat-scheduler";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function send(text: string) {
  const composer = screen.getByLabelText("Describe your concern");
  fireEvent.change(composer, { target: { value: text } });
  fireEvent.submit(composer.closest("form")!);
}

describe("chat scheduler prototype", () => {
  it("completes the deterministic symptom-to-confirmation flow", async () => {
    const { container } = render(<ChatScheduler />);

    send("I have had an itchy rash for three days");
    await screen.findAllByText(/When did this start/);

    send("It started three days ago and is staying about the same");
    await screen.findAllByText(/One more question/);

    send("No fever or injury, but the rash is itchy");
    await screen.findByRole("heading", { name: "Dermatology" });

    fireEvent.click(screen.getByRole("button", { name: "Find an appointment" }));
    fireEvent.click(screen.getByRole("button", { name: /Northside Clinic/ }));
    fireEvent.click(screen.getByRole("button", { name: /20 minutes/ }));

    await waitFor(() => {
      expect(container.querySelector(".choice-grid.three .choice")).toBeTruthy();
    });
    fireEvent.click(container.querySelector(".choice-grid.three .choice")!);

    await waitFor(() => {
      expect(container.querySelector(".choice-grid.three .choice")).toBeTruthy();
    });
    fireEvent.click(container.querySelector(".choice-grid.three .choice")!);

    fireEvent.change(screen.getByPlaceholderText("How should we address you?"), {
      target: { value: "Demo User" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm appointment" }));

    await screen.findByRole("heading", { name: /You’re all set, Demo User/ });
    expect(screen.getByText(/^HCS-[A-Z0-9]{6}$/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing was sent to a clinic/)).toBeInTheDocument();
  });
});
