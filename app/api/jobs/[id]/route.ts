import { getContext } from "@/server/context.mjs";
import * as h from "@/server/handlers.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type P = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: P) {
  return h.jobGet(req, getContext(), (await params).id);
}

export async function PUT(req: Request, { params }: P) {
  return h.jobPut(req, getContext(), (await params).id);
}
