import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("clean up face data", { hours: 1 }, internal.face.cleanup);
crons.interval(
  "clean up unfinished uploads",
  { minutes: 10 },
  internal.files.cleanupPending,
);

export default crons;
