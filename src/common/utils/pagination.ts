import type { Request } from "express";
import type { Document, FilterQuery, Model } from "mongoose";

export interface PaginationParams {
  page: number;
  limit: number;
  sort?: string;
  fields?: string;
}

export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

export function getPaginationParams(req: Request): PaginationParams {
  const page = Math.max(1, Number.parseInt(req.query["page"] as string) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query["limit"] as string) || 10));
  const sort = req.query["sort"] as string;
  const fields = req.query["fields"] as string;

  return { page, limit, sort, fields };
}

export async function paginate<T extends Document>(
  model: Model<T>,
  filter: FilterQuery<T>,
  params: PaginationParams
): Promise<PaginatedResult<T>> {
  const { page, limit, sort, fields } = params;
  const skip = (page - 1) * limit;

  let query = model.find(filter);

  // Apply sorting
  if (sort) {
    const sortFields = sort.split(",").join(" ");
    query = query.sort(sortFields);
  }

  // Apply field selection
  if (fields) {
    const selectFields = fields.split(",").join(" ");
    query = query.select(selectFields);
  }

  // Execute queries
  const [data, total] = await Promise.all([
    query.skip(skip).limit(limit).lean().exec(),
    model.countDocuments(filter),
  ]);

  const totalPages = Math.ceil(total / limit);

  return {
    data: data as T[],
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  };
}

function stripPaginationParams(query: Record<string, unknown>): Record<string, unknown> {
  const excludedFields = ["page", "limit", "sort", "fields"];
  return Object.keys(query)
    .filter((key) => !excludedFields.includes(key))
    .reduce(
      (obj, key) => {
        obj[key] = query[key];
        return obj;
      },
      {} as Record<string, unknown>
    );
}

function applyRangeQuery(filter: Record<string, unknown>, key: string, value: string): void {
  const parts = key.split("[");
  const field = parts[0];
  const operator = parts[1];
  if (!(field && operator)) return;
  const op = operator.replace("]", "");

  if (!filter[field]) {
    filter[field] = {};
  }
  (filter[field] as Record<string, unknown>)[`$${op}`] = value;
}

export function buildFilter(query: Record<string, unknown>): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  const filteredQuery = stripPaginationParams(query);

  for (const [key, value] of Object.entries(filteredQuery)) {
    if (typeof value === "string" && key.includes("[")) {
      applyRangeQuery(filter, key, value);
    } else if (typeof value === "string") {
      filter[key] = { $regex: value, $options: "i" };
    } else {
      filter[key] = value;
    }
  }

  return filter;
}
