import { getContext } from "@/server/context.mjs";
import * as h from "@/server/handlers.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type P = { params: Promise<{ id: string; photoId: string }> };

export async function GET(req: Request, { params }: P) {
  const p = await params;
  return h.jobPhoto(req, getContext(), p.id, p.photoId);
}
