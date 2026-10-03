import { getContext } from "@/server/context.mjs";
import * as h from "@/server/handlers.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return h.jobsList(req, getContext());
}

export async function POST(req: Request) {
  return h.jobsCreate(req, getContext());
}
