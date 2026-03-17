declare namespace Express {
  interface Request {
    id: string;
    user?: {
      id: string;
      email: string;
    };
  }
}