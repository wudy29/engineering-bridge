import { z } from "zod";

export const DASHBOARD_LABEL_MAX_LENGTH = 100;
export const dashboardLabelSchema = z.string().min(1).max(DASHBOARD_LABEL_MAX_LENGTH)
  .regex(/^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/)
  .refine(value => value.trim().length > 0, "A Dashboard label cannot be blank.");
