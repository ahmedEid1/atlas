import Link from "next/link";
import { Card } from "@/components/ui/card";

type Project = { id: string; title: string; question: string; updatedAt: Date };

export function ProjectList({ projects }: { projects: Project[] }) {
  if (projects.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">No projects yet. Create your first review above.</p>
    );
  }

  return (
    <ul className="grid gap-3 md:grid-cols-2">
      {projects.map((p) => (
        <li key={p.id}>
          <Link href={`/projects/${p.id}`}>
            <Card className="p-5 hover:bg-accent transition">
              <h2 className="font-medium">{p.title}</h2>
              <p className="text-sm text-muted-foreground line-clamp-2 mt-1">{p.question}</p>
              <p className="text-xs text-muted-foreground mt-3">
                Updated {new Date(p.updatedAt).toLocaleDateString()}
              </p>
            </Card>
          </Link>
        </li>
      ))}
    </ul>
  );
}
