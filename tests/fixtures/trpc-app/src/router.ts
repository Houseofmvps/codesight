import { publicProcedure, createTRPCRouter } from "./trpc";
export const userRouter = createTRPCRouter({
  list: publicProcedure.query(async () => []),
  create: publicProcedure.input(z.object({ name: z.string() })).mutation(async ({ input }) => ({})),
  getById: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => ({})),
});