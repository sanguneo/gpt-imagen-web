import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.each([0, 2])("MOSS CLI emits the released sampling graph with %i references", async (count) => {
  const root = await mkdtemp(join(tmpdir(), "moss-cli-"));
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
          return Response.json({ error: "moss graph captured" }, { status: 400 });
        default:
          return new Response("Unexpected route", { status: 404 });
      }
    },
  });
  try {
    const prompt = '{"summary":{"caption":"A fictional cafe sign"},"items":[]}';
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "gen.mjs"), "--model", "moss",
      ...Array.from({ length: count }, () => ["--ref", ref]).flat(), "--", prompt, "512x512"], {
      env: process.env, stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 10000,
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).toBe(1);
    expect(stderr).toContain("moss graph captured");
    expect(graph["451"].inputs.unet_name).toBe("moss_image_sft_int8_convrot.safetensors");
    expect(graph["453"].inputs.clip_name).toBe("qwen3.5_9b_int8_convrot.safetensors");
    expect(graph["453"].inputs.type).toBe("moss_image");
    expect(graph["454"].inputs.vae_name).toBe("flux2-vae_small.safetensors");
    expect(graph["456"].class_type).toBe("EmptyFlux2LatentImage");
    expect(graph["456"].inputs).toEqual({ width: 512, height: 512, batch_size: 1 });
    expect(graph["480"].inputs.single_layers).toBe("22");
    expect(graph["458"].inputs.sampler_name).toBe("euler");
    expect(graph["458"].inputs.steps).toBe(count ? 30 : 50);
    expect(graph["458"].inputs.cfg).toBe(count ? 4 : 3);
    expect(graph["458"].inputs.scheduler).toBe(count ? "normal" : "sgm_uniform");
    if (count) {
      expect(graph.mossEdit.inputs.lora_name).toBe("moss_image_edit_lora_rank_64_bf16.safetensors");
      expect(graph["480"].inputs.model).toEqual(["mossEdit", 0]);
      for (const id of ["452", "455"]) {
        expect(graph[id].class_type).toBe("TextEncodeMOSSImageEdit");
        expect(graph[id].inputs.edit_format).toBe("Moss-Image-Edit");
        expect(graph[id].inputs["images.image_0"]).toEqual(["ref1", 0]);
        expect(graph[id].inputs["images.image_1"]).toEqual(["ref2", 0]);
        expect(graph[id].inputs.vae).toEqual(["454", 0]);
      }
      expect(graph["452"].inputs.prompt).toBe(prompt);
    } else {
      expect(graph["452"].inputs.text).toBe(prompt);
      expect(graph["481"].class_type).toBe("ModelSamplingAuraFlow");
      expect(graph["481"].inputs.shift).toBe(5);
      expect(graph["480"].inputs.model).toEqual(["481", 0]);
      expect(graph.mossEdit).toBeUndefined();
    }
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("MOSS CLI rejects five references before contacting ComfyUI", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "gen.mjs"), "--model", "moss",
    ...Array.from({ length: 5 }, () => ["--ref", "/missing.png"]).flat(), "--", "A cafe", "512x512"], {
    env: process.env, stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 10000,
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code).toBe(2);
  expect(stderr).toContain("At most 4");
});
