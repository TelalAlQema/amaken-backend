const express = require("express");
const { z } = require("zod");
const { OpenAPIRegistry, OpenApiGeneratorV31, extendZodWithOpenApi } = require("@asteasolutions/zod-to-openapi");
const { collectRoutes } = require("../../../scripts/route-table");

extendZodWithOpenApi(z);

const PaginationSchema = z.object({
  page: z.number().int().min(1),
  limit: z.number().int().min(1),
  total: z.number().int().min(0),
  totalPages: z.number().int().min(0),
}).openapi("Pagination");
const ErrorSchema = z.object({
  success: z.literal(false),
  error: z.object({ message: z.string(), code: z.string().optional() }),
}).openapi("Error");
const SuccessSchema = z.object({ success: z.literal(true), data: z.unknown() }).openapi("Success");
const PaginatedSchema = z.object({
  success: z.literal(true),
  data: z.object({ items: z.array(z.unknown()), pagination: PaginationSchema }),
}).openapi("PaginatedResponse");

/** Build a real OpenAPI 3.1 document from the mounted Express route table. */
function createOpenApiDocument(modules) {
  const app = express();
  for (const module of modules) {
    for (const mount of module.mounts) app.use(mount.path, ...mount.guards, mount.router);
  }

  const registry = new OpenAPIRegistry();
  registry.register("Pagination", PaginationSchema);
  registry.register("Error", ErrorSchema);
  registry.register("Success", SuccessSchema);
  registry.register("PaginatedResponse", PaginatedSchema);

  const routes = collectRoutes(app);
  routes.push(
    { path: "/api", methods: ["GET"] },
    { path: "/api/docs", methods: ["GET"] },
    { path: "/health", methods: ["GET"] },
    { path: "/health/live", methods: ["GET"] },
    { path: "/health/ready", methods: ["GET"] },
    { path: "/metrics", methods: ["GET"] },
  );

  for (const route of routes) {
    const path = route.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}").replace(/\/$/, "") || "/";
    for (const method of route.methods) {
      const params = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
      const operation = {
        method: method.toLowerCase(),
        path,
        tags: [path.startsWith("/api/admin/") ? path.split("/")[3] : path.split("/")[2] || "operational"],
        summary: `${method} ${path}`,
        ...(params.length ? { request: { params: z.object(Object.fromEntries(params.map((name) => [name, z.string()]))) } } : {}),
        responses: {
          200: {
            description: "Successful response",
            content: {
              "application/json": {
                schema: isPaginatedPath(path, method)
                  ? PaginatedSchema
                  : path === "/api"
                    ? z.object({ message: z.string(), version: z.string(), docs: z.string() })
                    : ["/api/docs", "/health", "/health/live", "/health/ready"].includes(path)
                      ? z.record(z.unknown())
                      : SuccessSchema,
              },
            },
          },
          400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
          401: { description: "Authentication required", content: { "application/json": { schema: ErrorSchema } } },
        },
      };
      if (path === "/api/admin/leads/export") {
        operation.responses[200].content = { "text/tab-separated-values": { schema: z.string() } };
      }
      if (path === "/metrics") {
        operation.responses[200].content = { "text/plain; version=0.0.4": { schema: z.string() } };
      }
      registry.registerPath(operation);
    }
  }

  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: "3.1.0",
    info: { title: "Amaken Real Estate API", version: "0.1.0", description: "OpenAPI contract generated from the registered Express route table and shared Zod response schemas." },
    servers: [{ url: "/" }],
  });
}

function isPaginatedPath(path, method) {
  if (method !== "GET") return false;
  return new Set([
    "/api/properties",
    "/api/properties/",
    "/api/properties/my",
    "/api/admin/users",
    "/api/admin/users/agents",
    "/api/admin/users/builders",
    "/api/admin/accounts/registered",
    "/api/admin/accounts/deleted",
    "/api/admin/accounts/blocked",
    "/api/admin/properties",
    "/api/admin/properties/approval",
    "/api/admin/leads",
    "/api/admin/contacts",
    "/api/admin/feedback/company",
    "/api/admin/feedback/agents",
    "/api/feedback/my",
    "/api/feedback/about-me",
  ]).has(path) || path.startsWith("/api/properties/state/");
}

module.exports = { createOpenApiDocument };
