"use client";

import { PipelineAnalyticsContent } from "@/components/analytics/PipelineAnalyticsContent";

export default function PipelineAnalyticsPage() {
  return (
    <section className="min-w-0 pb-16">
      <PipelineAnalyticsContent hideHeader={false} />
    </section>
  );
}
