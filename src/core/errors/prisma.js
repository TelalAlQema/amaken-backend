/**
 * Prisma error translation.
 *
 * Prisma throws `PrismaClientKnownRequestError` with a `code` (`P2002`,
 * `P2025`, …) and no HTTP meaning. Every module that touches the database
 * would otherwise have to re-derive "unique violation means 409" and "required
 * record missing means 404" at each call site, and get it subtly different.
 * This is the single place that decision is made.
 *
 * Only the two mappings that are unambiguous are implemented. The other known
 * codes are listed below with their correct meanings and are deliberately *not*
 * mapped yet: each one needs a per-module message that only the module's author
 * can supply, and a guessed message is worse than a 500 in the log.
 *
 * | Code   | Meaning                        | Status |
 * |--------|--------------------------------|--------|
 * | P2002  | unique constraint failed       | 409    |
 * | P2025  | record required, not found     | 404    |
 * | P2003  | foreign key constraint failed  | 409    | M03+ — needs the constraint name
 * | P2014  | required relation missing      | 409    | M03+ — needs the relation name
 * | P2034  | transaction conflict           | 409    | M05+ — retryable, needs a queue
 * | P2039  | transaction failed             | 500    | never a client error
 */
const { AppError } = require("./AppError");
const { ErrorCode } = require("./codes");

/**
 * Duck-typed rather than `instanceof PrismaClientKnownRequestError`: the class is
 * exported from the generated client, which is regenerated on every
 * `prisma generate`, and an `instanceof` across two copies of the module is a
 * silent `false`. Prisma's own error carries a `code` shaped like `P\d{4}`.
 */
function isPrismaError(err) {
  return Boolean(
    err &&
      typeof err === "object" &&
      typeof err.code === "string" &&
      /^P\d{4}$/.test(err.code) &&
      typeof err.message === "string"
  );
}

/**
 * @param {unknown} err
 * @param {{ conflictMessage?: string, notFoundMessage?: string }} [messages]
 * @returns {AppError | null} `null` when the error is not a mapped Prisma code.
 */
function fromPrisma(err, messages = {}) {
  if (!isPrismaError(err)) return null;

  switch (err.code) {
    case "P2002":
      return new AppError(
        messages.conflictMessage || "A record with these values already exists",
        409,
        ErrorCode.CONFLICT,
        { prismaCode: err.code }
      );

    case "P2025":
      return new AppError(
        messages.notFoundMessage || "Record not found",
        404,
        ErrorCode.NOT_FOUND,
        { prismaCode: err.code }
      );

    default:
      return null;
  }
}

module.exports = { isPrismaError, fromPrisma };
