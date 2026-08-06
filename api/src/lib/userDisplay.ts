type UserLike = {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
};

export function formatUserRef(user: UserLike) {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName ?? null,
    lastName: user.lastName ?? null,
  };
}
