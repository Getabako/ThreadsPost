import { getContext } from "@/server/context.mjs";
import * as h from "@/server/handlers.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type P = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: P) {
  return h.jobExportZip(req, getContext(), (await params).id);
}
