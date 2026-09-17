import { ShotService } from "@/server/services/shot-service";

export const dynamic = "force-dynamic";

// Authenticated by middleware. A GET avoids serializing progress reads with the Stop server action.
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const result = await new ShotService().liveProgress(id);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "无法确认 ComfyUI 状态，正在重连" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
