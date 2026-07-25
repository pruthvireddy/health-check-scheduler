import { ChatScheduler } from "@/components/chat-scheduler";

const CHAT_MODES = ["local", "hybrid", "llm-required"] as const;
type ChatMode = (typeof CHAT_MODES)[number];

function configuredChatMode(): ChatMode {
  const mode = process.env.CHAT_MODE;
  return CHAT_MODES.includes(mode as ChatMode) ? (mode as ChatMode) : "hybrid";
}

export default function Home() {
  return <ChatScheduler chatMode={configuredChatMode()} />;
}
