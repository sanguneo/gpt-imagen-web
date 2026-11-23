import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.each([0, 2])("Identity CLI rejects %i references before contacting ComfyUI", async (count) => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "gen.mjs"), "--model", "krea2-id",
    ...Array.from({ length: count }, () => ["--ref", "/missing.png"]).flat(), "--", "Restage this person", "512x512"], {
    env: process.env, stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 10000,
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code).toBe(2);
  expect(stderr).toContain("exactly one reference");
});

test("Identity CLI sends the uploaded reference through both conditioning paths with the V2 preset", async () => {
  const root = await mkdtemp(join(tmpdir(), "krea-id-"));
  const ref = join(root, "ref.png");
  await writeFile(ref, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"));
  let graph;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 8188,
    async fetch(request) {
      switch (new URL(request.url).pathname) {
        case "/system_stats":
          return Response.json({ system: { argv: [join(import.meta.dir, "ComfyUI/main.py")] } });
        case "/upload/image": {
          const image = (await request.formData()).get("image");
          expect(Buffer.from(await image.arrayBuffer())).toEqual(await Bun.file(ref).bytes());
          return Response.json({ name: "uploaded.png", subfolder: "refs" });
        }
        case "/prompt":
          graph = (await request.json()).prompt;
          return Response.json({ error: "identity graph captured" }, { status: 400 });
        default:
          return new Response("Unexpected route", { status: 404 });
      }
    },
  });
  try {
    const prompt = "The same woman walking on a beach at sunset, full body";
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "gen.mjs"), "--model", "krea2-id", "--ref", ref, "--", prompt, "512x512"], {
      env: process.env, stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 10000,
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).toBe(1);
    expect(stderr).toContain("identity graph captured");
    expect(graph.ref1.inputs.image).toBe("refs/uploaded.png");
    expect(graph["451"].inputs.unet_name).toBe("krea2_turbo_fp8_scaled.safetensors");
    expect(graph["480"].inputs.lora_name).toBe("krea2_identity_edit_v2_r64.safetensors");
    expect(graph["452"].class_type).toBe("Krea2EditGroundedEncode");
    expect(graph["452"].inputs.prompt).toBe(prompt);
    expect(graph["452"].inputs.image).toEqual(["ref1", 0]);
    expect(graph["455"].inputs.image).toEqual(["ref1", 0]);
    expect(graph["452"].inputs.grounding_px).toBe(768);
    expect(graph.identity.inputs.source_image).toEqual(["ref1", 0]);
    expect(graph.identity.inputs.target_latent).toEqual(graph["458"].inputs.latent_image);
    expect(graph.identity.inputs.ref_boost).toBe(2);
    expect(graph.identity.inputs.ref_position).toBe("beside (right of target)");
    expect(graph["458"].inputs.steps).toBe(8);
    expect(graph["458"].inputs.cfg).toBe(1);
    expect(Object.values(graph).filter(node => node.class_type === "LoraLoaderModelOnly")).toHaveLength(1);
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
