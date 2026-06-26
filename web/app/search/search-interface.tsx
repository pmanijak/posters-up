"use client";

// app/search/search-interface.tsx
//
// Client component: message history, input, streaming response display.
// Parent (page.tsx) renders PageHeader above this component.
//
// Message format sent to the API: {role: 'user'|'assistant', content: string}[]
// Tool use is internal to the API route — this component never sees it.
//
// Chat history is persisted to sessionStorage so navigation away and back
// (e.g. tapping an event link) doesn't lose the conversation.
// sessionStorage dies with the tab — no cross-session persistence.

import { useState, useRef, useEffect, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";

interface Message {
  role: "user" | "assistant";
  content: string;
}

const STORAGE_KEY = "search-messages";

const SUGGESTIONS = [
  "What's on this weekend?",
  "Any free shows coming up?",
  "Music this week?",
  "Anything all-ages?",
];

export function ChatInterface() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Restore messages from sessionStorage on mount
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY);
      if (saved) setMessages(JSON.parse(saved));
    } catch {}
  }, []);

  // Persist messages to sessionStorage whenever they change.
  // Guard against empty array clobbering a saved session on mount.
  useEffect(() => {
    try {
      if (messages.length > 0) {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
      }
    } catch {}
  }, [messages]);

  // Scroll to bottom whenever messages update
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function submit(text: string) {
    if (!text.trim() || loading) return;

    const userMsg: Message = { role: "user", content: text.trim() };
    setInput("");
    setLoading(true);

    // Optimistically add user message + empty assistant placeholder
    setMessages((prev) => [
      ...prev,
      userMsg,
      { role: "assistant", content: "" },
    ]);

    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Send the full history so Claude has conversation context,
          // but exclude the empty placeholder we just added.
          messages: [...messages, userMsg].map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
      });

      if (!res.ok) throw new Error(`${res.status}`);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (!data) continue;

          try {
            const payload = JSON.parse(data);

            if (payload.text) {
              // Append streamed text to the assistant placeholder
              setMessages((prev) => {
                const next = [...prev];
                next[next.length - 1] = {
                  ...next[next.length - 1],
                  content: next[next.length - 1].content + payload.text,
                };
                return next;
              });
            }

            if (payload.error) {
              setMessages((prev) => {
                const next = [...prev];
                next[next.length - 1] = {
                  role: "assistant",
                  content: payload.error,
                };
                return next;
              });
            }
          } catch {}
        }
      }
    } catch {
      setMessages((prev) => {
        const next = [...prev];
        next[next.length - 1] = {
          role: "assistant",
          content: "Something went wrong. Try again.",
        };
        return next;
      });
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    submit(input);
  }

  function clearChat() {
    setMessages([]);
    sessionStorage.removeItem(STORAGE_KEY);
  }

  return (
    // flex-1 fills the space below PageHeader (parent is flex-col)
    <div className="flex-1 flex flex-col min-h-0">
      {/* ── Message list ─────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-4 py-6">
          {messages.length === 0 ? (
            // Empty state — suggestions act as quick-start prompts
            <div className="pt-12 space-y-8">
              <div className="space-y-1">
                <p className="font-marker text-2xl text-content-primary">
                  Ask about events
                </p>
                <p className="text-sm text-content-muted">
                  What's going on in Olympia, from the boards.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => submit(s)}
                    className="text-sm px-3 py-1.5 rounded-sm bg-surface-card border border-edge text-content-muted hover:text-content-secondary transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-4 pb-4">
              {messages.map((m, i) => (
                <div
                  key={i}
                  className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`
                      text-sm leading-relaxed
                      ${
                        m.role === "user"
                          ? "max-w-[85%] rounded-sm px-4 py-3 bg-surface-raised text-content-primary"
                          : "w-full text-content-secondary"
                      }
                    `}
                  >
                    {/* Show ellipsis while the assistant placeholder is empty */}
                    {m.role === "user" ? (
                      m.content
                    ) : m.content ? (
                      <ReactMarkdown
                        components={{
                          p: ({ children }) => (
                            <p className="mb-2 last:mb-0">{children}</p>
                          ),
                          strong: ({ children }) => (
                            <strong className="font-semibold text-content-primary">
                              {children}
                            </strong>
                          ),
                          ul: ({ children }) => (
                            <ul className="mt-1 mb-2 space-y-1 last:mb-0">
                              {children}
                            </ul>
                          ),
                          li: ({ children }) => (
                            <li className="flex gap-2">
                              <span className="text-content-muted shrink-0">
                                ·
                              </span>
                              <span>{children}</span>
                            </li>
                          ),
                          a: ({ href, children }) => (
                            <a
                              href={href}
                              target={
                                href?.startsWith("/") ? "_self" : "_blank"
                              }
                              rel={
                                href?.startsWith("/")
                                  ? undefined
                                  : "noopener noreferrer"
                              }
                              className="underline underline-offset-2 decoration-dotted text-content-secondary hover:text-content-primary transition-colors"
                            >
                              {children}
                            </a>
                          ),
                        }}
                      >
                        {m.content}
                      </ReactMarkdown>
                    ) : loading && i === messages.length - 1 ? (
                      <span className="text-content-muted">…</span>
                    ) : null}
                  </div>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>
          )}
        </div>
      </div>

      {/* ── Input bar ────────────────────────────────────────────────── */}
      <div className="border-t border-edge bg-surface-page">
        <form
          onSubmit={handleSubmit}
          className="max-w-2xl mx-auto px-4 py-3 flex gap-2"
        >
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="What's happening this week?"
            disabled={loading}
            autoComplete="off"
            className="
              flex-1 bg-surface-raised border border-edge rounded-sm
              px-3 py-2 text-sm text-content-primary
              placeholder:text-content-muted
              focus:outline-none focus:border-content-muted
              disabled:opacity-50
            "
          />
          <button
            type="submit"
            disabled={!input.trim() || loading}
            className="
              px-4 py-2 text-sm rounded-sm
              bg-surface-raised border border-edge
              text-content-secondary
              disabled:opacity-40
              transition-opacity
            "
          >
            Send
          </button>
          {messages.length > 0 && (
            <button
              type="button"
              onClick={clearChat}
              className="
                px-4 py-2 text-sm rounded-sm
                border border-edge
                text-content-muted hover:text-content-secondary
                transition-colors whitespace-nowrap"
            >
              New search
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
