/**
 * Conversion des schemas Zod des outils en JSON Schema (inputSchema MCP).
 *
 * Utilise le convertisseur natif de zod 4 : les schemas raffines (refine/superRefine)
 * gardent leurs proprietes et les contraintes (min, max, pattern, enum, default) sont exposees.
 * Le convertisseur maison precedent renvoyait {type: 'object'} vide pour vm_snapshot et backup_create.
 */
import { z } from 'zod';

export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  // io 'input' : un champ avec valeur par defaut n'est pas requis cote client
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  return jsonSchema;
}
