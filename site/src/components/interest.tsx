"use client";
import { useState } from "react";
import { SITE, xUrl } from "@/lib/site";

// Email interest form + X follow. Posts to NEXT_PUBLIC_INTEREST_URL; without one it says signups aren't open.
export function Interest({ compact = false }: { compact?: boolean }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");
  const open = !!SITE.interestEndpoint;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!open) return;
    setState("sending");
    try {
      const r = await fetch(SITE.interestEndpoint, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setState("done"); setMsg("You're subscribed. Weekly results, wins and losses. Unsubscribe any time.");
    } catch (err) {
      setState("error"); setMsg(`Couldn't sign you up (${err instanceof Error ? err.message : "network error"}). Try again?`);
    }
  }

  return (
    <div id="subscribe" className={`interest ${compact ? "compact" : ""}`}>
      {!compact && <div><b>Weekly results, wins and losses.</b> Follow the entries on X.</div>}
      <form onSubmit={submit}>
        <input type="email" required placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)}
          disabled={!open || state === "sending" || state === "done"} aria-label="Email address" />
        <button className="btn primary" disabled={!open || state === "sending" || state === "done"}>
          {state === "sending" ? "Sending…" : "Subscribe"}</button>
        {xUrl() ? <a className="btn" href={xUrl()} target="_blank" rel="noopener noreferrer">Follow on X</a>
          : <span className="btn" aria-disabled>Follow on X (soon)</span>}
      </form>
      <div className="note">{msg || (open ? "Email only. No tracking, no sharing, delete on request." : "Signups open shortly.")}</div>
    </div>
  );
}
