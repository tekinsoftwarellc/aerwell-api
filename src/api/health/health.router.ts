import { Router } from "express";
import mongoose from "mongoose";
import { ServiceResponse } from "../../common/models/serviceResponse.js";

const router = Router();

interface HealthData {
  status: string;
  uptime: number;
  timestamp: string;
  database: {
    status: string;
    name: string | undefined;
  };
}

router.get("/", (_req, res) => {
  const dbState = mongoose.connection.readyState;
  const dbStatus = dbState === 1 ? "connected" : "disconnected";

  const healthData: HealthData = {
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    database: {
      status: dbStatus,
      name: mongoose.connection.name,
    },
  };

  const response = ServiceResponse.success("Health check passed", healthData);
  res.status(response.statusCode).json(response);
});

router.get("/live", (_req, res) => {
  const response = ServiceResponse.success("Server is alive", { alive: true });
  res.status(response.statusCode).json(response);
});

router.get("/ready", (_req, res) => {
  const dbState = mongoose.connection.readyState;

  if (dbState !== 1) {
    const response = ServiceResponse.error("Database not ready", null, 503);
    res.status(response.statusCode).json(response);
    return;
  }

  const response = ServiceResponse.success("Server is ready", { ready: true });
  res.status(response.statusCode).json(response);
});

export const healthRouter = router;
