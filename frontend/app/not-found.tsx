import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-white px-6 text-center text-slate-900">
      <h1 className="text-2xl font-bold">Page not found</h1>
      <p className="max-w-md text-slate-600">
        The page you requested does not exist or may have moved.
      </p>
      <Link
        href="/"
        className="rounded-md bg-[#FF5A1F] px-4 py-2 text-sm font-semibold text-white hover:bg-[#E54E1A]"
      >
        Back to home
      </Link>
    </main>
  );
}
