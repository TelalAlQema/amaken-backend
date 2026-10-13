/**
 * `admin` column mapping.
 *
 * Unlike `users.mapper`, this one renames nothing: every field in
 * `updateAdminProfileSchema` has the same name as its column (`aname` → `aname`,
 * `aAddress` → `aAddress`). So there is no field table here, only the two
 * behaviours the legacy service had inline.
 *
 * That asymmetry with `modules/users` is worth noting, because it is the reason
 * this file is small: the `user` table spells its columns in four cases
 * (`phone`/`uphone`, `address`/`Address`), the `admin` table spells them all the
 * same way. If a field is ever added to the admin profile it lands on the same
 * name and this file does not need to change.
 */

/**
 * Converts a validated `PUT /admin/profile` body into an `admin.update` payload.
 *
 * Only keys that are present are copied, so a partial submit does not null out
 * fields it did not mention. An **empty body is a valid no-op** that issues an
 * `update` with `data: {}` — Prisma treats that as a statement that changes
 * nothing but still bumps nothing, and it returns the row.
 *
 * `""` is written as `""`, not `null`, and this is different from the admin
 * *links* endpoint which maps `""` to `null`. The two write to different columns
 * (`admin.afb` vs `adminSocial.facebook`) and the admin UI sends `""` from both
 * forms, so the same keystroke produces a `null` in one table and an empty string
 * in the other. Preserved.
 *
 * @param {Record<string, unknown>} body a validated `updateAdminProfileSchema` body
 * @returns {Record<string, unknown>} a Prisma `data` payload
 */
function toProfileUpdate(body) {
  const data = {};

  for (const [field, value] of Object.entries(body)) {
    if (value !== undefined) data[field] = value;
  }

  return data;
}

/**
 * The `adminSocial` create/update payloads.
 *
 * Returned as a pair of objects rather than built inside the repository, because
 * the asymmetry between them is a *policy* decision — "first write creates all six
 * columns, later writes only touch the ones named" — and putting it in the mapper
 * next to the field names makes it legible without opening the repository.
 *
 * `""` → `null` on create (there is no value to distinguish from absent), and
 * `undefined` → `undefined` on update (Prisma reads that as "leave alone"). The
 * two mappings are not the same, which is the point of returning both.
 *
 * @param {Record<string, string | undefined>} body a validated `adminLinksSchema` body
 * @returns {{ create: Record<string, unknown>, update: Record<string, unknown> }}
 */
function toSocialLinkPayload(body) {
  return {
    create: {
      website: body.website || null,
      facebook: body.facebook || null,
      linkedin: body.linkedin || null,
      instagram: body.instagram || null,
      tiktok: body.tiktok || null,
      twitter: body.twitter || null,
    },
    update: {
      website: body.website ?? undefined,
      facebook: body.facebook ?? undefined,
      linkedin: body.linkedin ?? undefined,
      instagram: body.instagram ?? undefined,
      tiktok: body.tiktok ?? undefined,
      twitter: body.twitter ?? undefined,
    },
  };
}

module.exports = { toProfileUpdate, toSocialLinkPayload };