declare namespace Express {
  interface Request {
    id: string;
    user?: {
      id: string;
      email: string;
    };
    membership?: {
      workspaceId: string;
      userId: string;
      role: string;
    };
  }
}