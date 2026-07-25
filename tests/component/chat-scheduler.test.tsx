import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ChatScheduler } from "@/components/chat-scheduler";
import { syntheticFallbackResponse } from "@/lib/llm";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

function send(text: string) {
  const composer = screen.getByLabelText("Describe your concern");
  fireEvent.change(composer, { target: { value: text } });
  fireEvent.submit(composer.closest("form")!);
}

describe("chat scheduler prototype", () => {
  it("completes a local conversation turn without calling the enhancement API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<ChatScheduler chatMode="local" />);

    send("I have had an itchy rash for three days");

    await screen.findAllByText(/When did (?:this start|these symptoms first begin)/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText("Local rules mode")).toBeInTheDocument();
  });

  it("surfaces provider failures when AI is required", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => ({ error: { code: "provider_unavailable" } }),
      })),
    );
    render(<ChatScheduler chatMode="llm-required" />);

    send("I have had an itchy rash for three days");

    await screen.findAllByText(/AI enhancement is unavailable in required mode/);
    expect(screen.getByText("AI unavailable")).toBeInTheDocument();
  });

  it("uses validated model wording with an application-owned follow-up", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          mode: "llm",
          modelVersion: "test/model",
          extractedEvidence: [],
          nextAction: "ask_follow_up",
          questionType: "severity",
          confidence: 0.91,
          conversationalLead:
            "That sounds uncomfortable, and the detail you shared is helpful.",
          explanation: "A severity follow-up can clarify the scheduling route.",
        }),
      })),
    );
    render(<ChatScheduler chatMode="hybrid" />);

    send("I have had an itchy rash for three days");

    await screen.findAllByText(
      /That sounds uncomfortable.*How severe are the symptoms/,
    );
    expect(screen.getByText("AI-assisted mode")).toBeInTheDocument();
  });

  it("completes the deterministic symptom-to-confirmation flow", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => ({
        ok: true,
        status: 200,
        json: async () => syntheticFallbackResponse("No model token configured"),
      }),
    );
    vi.stubGlobal(
      "fetch",
      fetchMock,
    );
    const { container } = render(<ChatScheduler />);

    send("I have had an itchy rash for three days");
    await screen.findAllByText(/When did (?:this start|these symptoms first begin)/);

    send("It started three days ago and is staying about the same");
    await screen.findAllByText(/One more question|other symptoms/i);

    send("No fever or injury, but the rash is itchy");
    await screen.findByRole("button", { name: /Dermatology/ });

    fireEvent.click(screen.getByRole("button", { name: "Find an appointment" }));
    fireEvent.click(await screen.findByRole("button", { name: /Northside Clinic/ }));
    fireEvent.click(await screen.findByRole("button", { name: /20 minutes/ }));

    const dateSection = await screen.findByRole("region", { name: "Select date" });
    fireEvent.click(within(dateSection).getAllByRole("button")[0]);

    const timeSection = await screen.findByRole("region", { name: "Select time" });
    fireEvent.click(within(timeSection).getAllByRole("button")[0]);

    fireEvent.change(await screen.findByPlaceholderText("How should we address you?"), {
      target: { value: "Demo User" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm appointment" }));

    await screen.findByRole("heading", { name: /You’re all set, Demo User/ });
    expect(screen.getByText(/^HCS-[A-Z0-9]{6}$/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing was sent to a clinic/)).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(9));
    const confirmationInit = fetchMock.mock.calls.at(-1)?.[1];
    const confirmationRequest = JSON.parse(String(confirmationInit?.body));
    expect(confirmationRequest).toMatchObject({
      stage: "confirmed",
      purpose: "confirmation",
    });
  });
});
