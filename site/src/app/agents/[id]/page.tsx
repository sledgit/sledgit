import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ALL_BOTS, botById } from "@/lib/bots";
import { AgentView } from "./view";

export function generateStaticParams() {
  return ALL_BOTS.map(b => ({ id: b.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const b = botById((await params).id);
  return b ? { title: `${b.name} · ${b.model === "—" ? b.strategy : b.model}`, description: `${b.name}: every decision, the vault's limits and the proof behind the record. ${b.description}` } : {};
}

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!botById(id)) notFound();
  return <AgentView id={id} />;
}
