export function BehavioralSuiteCard({ title, description }: { title: string; description: string }) {
  return <div className="rounded-lg border p-4"><h3 className="font-semibold">{title}</h3><p className="text-sm text-muted-foreground">{description}</p></div>
}
