export default function UserProfile({ name, email, avatar }: { name: string; email: string; avatar?: string }) {
  return <div>{name} - {email}</div>;
}