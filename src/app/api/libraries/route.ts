import { NextResponse } from "next/server";
import { findOrCreateLibrary, listLibraries } from "@/lib/libraries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ libraries: listLibraries() });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { name?: string };
  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "Library name required" }, { status: 400 });
  const lib = findOrCreateLibrary(name);
  return NextResponse.json({ id: lib.id, name: lib.name });
}
