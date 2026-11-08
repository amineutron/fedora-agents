/**
 * Outil MCP : vm_image_fetch (telecharge une image cloud du catalogue dans VM_IMAGES_DIR).
 *
 * Seules les entrees du catalogue qui portent une URL https officielle sont telechargeables ;
 * l'appelant ne fournit qu'un identifiant. Telechargement dans un fichier `.part` du meme dossier,
 * controle du format par qemu-img, puis renommage : un fichier partiel n'est jamais pris pour une image.
 */

import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ErrorCode } from '../config.js';
import { run } from '../utils/runner.js';
import { vmImageFetchSchema, type VmImageFetchParams } from '../utils/vm-hub-schemas.js';
import { downloadExtension, findCachedImage, findImage, imagesDir } from '../utils/vm-images.js';
import { fail, ok } from '../utils/virsh.js';
import { inspectDisk } from './vm-create.js';
import type { ToolDefinition, ToolResult } from './vm-controller.js';

const TOOL = 'vm_image_fetch';
const T_DOWNLOAD = 1_800_000;
const MAX_DOWNLOAD_BYTES = 4 * 1024 ** 3;

/** Arguments curl : https uniquement (aussi apres redirection), taille bornee, echec sur code HTTP >= 400. */
export function curlArgs(url: string, output: string): string[] {
  return [
    '--fail', '--silent', '--show-error', '--location',
    '--proto', '=https', '--proto-redir', '=https',
    '--max-filesize', String(MAX_DOWNLOAD_BYTES),
    '--connect-timeout', '20',
    '--output', output, url
  ];
}

async function vmImageFetchHandler(params: unknown): Promise<ToolResult> {
  const { image_id: id } = vmImageFetchSchema.parse(params) as VmImageFetchParams;
  const entry = findImage(id);
  if (!entry) return fail(ErrorCode.VALIDATION_ERROR, `Image inconnue: ${id}`);
  const dir = imagesDir();

  if (entry.fmt === 'vb') {
    return fail(ErrorCode.VALIDATION_ERROR, `'${id}' est une image virt-builder : rien a telecharger ici (virt-builder la recupere a la creation)`);
  }
  if (!entry.url) {
    return fail(ErrorCode.VALIDATION_ERROR, `Aucune URL officielle fiable enregistree pour '${id}' : image a placer a la main dans ${dir}`, { image_id: id, images_dir: dir });
  }

  const existing = await findCachedImage(dir, entry);
  if (existing !== null) {
    return ok({ image_id: id, path: existing, bytes: (await stat(existing)).size, already_present: true });
  }

  await mkdir(dir, { recursive: true, mode: 0o700 });
  const partial = join(dir, `.${id}.${randomBytes(4).toString('hex')}.part`);
  const target = join(dir, `${id}${downloadExtension(entry)}`);
  try {
    const r = await run('curl', curlArgs(entry.url, partial), { tool: TOOL, timeoutMs: T_DOWNLOAD });
    if (r.code !== 0) return fail(ErrorCode.SCRIPT_ERROR, `Telechargement de '${id}' echoue : ${r.stderr || `curl code ${r.code}`}`);

    const info = await inspectDisk(partial);
    if (typeof info === 'string') return fail(ErrorCode.SCRIPT_ERROR, `Fichier telecharge refuse : ${info}`);
    await rename(partial, target);
    return ok({ image_id: id, path: target, bytes: (await stat(target)).size, format: info.format, already_present: false });
  } finally {
    await rm(partial, { force: true });
  }
}

export const vmImageFetch: ToolDefinition = {
  name: 'vm_image_fetch',
  description: 'Telecharge dans ~/vm-images une image cloud du catalogue interne (image_id), depuis son adresse https officielle fixe. Sans effet si l\'image est deja la. Les ISO et images sans lien stable se placent a la main.',
  inputSchema: vmImageFetchSchema,
  handler: vmImageFetchHandler
};

export const vmImageFetchTools: ToolDefinition[] = [vmImageFetch];
