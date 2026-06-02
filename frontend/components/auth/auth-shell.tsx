import { Card } from "@/components/ui/card";
import Link from "next/link";

type AuthShellProps = {
  title: string;
  subtitle: string;
  leftTitle?: string;
  leftSubtitle?: string;
  children: React.ReactNode;
};

export function AuthShell({ title, subtitle, leftTitle, leftSubtitle, children }: AuthShellProps) {
  return (
    <main className="flex min-h-screen w-full bg-white font-sans">
      {/* Left Column - Branding (Hidden on small screens) */}
      <div className="hidden lg:flex sticky top-0 h-screen w-full lg:w-[40%] xl:w-[35%] flex-col justify-between p-8 lg:p-10 bg-[#FAFAFB] border-r border-gray-100 relative overflow-hidden">
        {/* Ultra-clean solid background */}

        {/* Top: Logo */}
        <div className="relative z-10">
          <Link href="/" className="flex items-center gap-3">
            <div className="relative flex items-center justify-center w-8 h-8">
              <div className="absolute inset-0 bg-gradient-to-br from-[#FF5A1F] to-[#E03A00] rounded-lg transform rotate-45 shadow-sm"></div>
              <span className="relative text-white font-bold text-[18px] drop-shadow-md">A</span>
            </div>
            <span className="font-bold text-2xl tracking-tight text-[#111827]">AIRIS</span>
          </Link>
        </div>

        {/* Middle: Content */}
        <div className="relative z-10 flex flex-col justify-center flex-1 py-8">
          <h1 className="text-[32px] font-bold text-[#111827] tracking-tight mb-3">{leftTitle || "Welcome back"}</h1>
          <p className="text-[15px] text-gray-500 font-medium">{leftSubtitle || "Sign in to continue to your AIRIS workspace."}</p>
        </div>

      </div>

      {/* Right Column - Form Container */}
      <div className="flex-1 flex flex-col relative bg-[#F9FAFB] sm:bg-[#F3F4F6] lg:bg-[#ffffff] min-h-screen">
        {/* Mobile Header */}
        <div className="lg:hidden p-6 flex justify-start border-b border-gray-100 bg-white">
          <Link href="/" className="flex items-center gap-2">
            <div className="relative flex items-center justify-center w-7 h-7">
              <div className="absolute inset-0 bg-gradient-to-br from-[#FF5A1F] to-[#E03A00] rounded-md transform rotate-45 shadow-sm"></div>
              <span className="relative text-white font-bold text-base drop-shadow-md">A</span>
            </div>
            <span className="font-bold text-xl tracking-tight text-[#111827]">AIRIS</span>
          </Link>
        </div>

        {/* Centered Form Card */}
        <div className="flex-1 flex items-center justify-center p-4 sm:p-6 lg:p-8">
          <Card className="w-full max-w-[440px] bg-white border-0 sm:border sm:border-gray-100 sm:shadow-[0_8px_30px_rgb(0,0,0,0.04)] rounded-none sm:rounded-[1.5rem] p-6 sm:p-8">
            <div className="mb-6">
              <h2 className="text-[22px] font-bold text-[#111827] tracking-tight mb-1.5">{title}</h2>
              <p className="text-[13px] text-gray-500 font-medium">{subtitle}</p>
            </div>
            {children}
          </Card>
        </div>

        {/* Footer */}
        <div className="py-8 flex flex-wrap justify-center gap-x-6 gap-y-2 text-[12px] font-medium text-gray-400">
          <span>© 2026 AIRIS. All rights reserved.</span>
          <span className="hidden sm:inline text-gray-300">•</span>
          <Link href="#" className="hover:text-gray-600 transition-colors">Privacy Policy</Link>
          <span className="hidden sm:inline text-gray-300">•</span>
          <Link href="#" className="hover:text-gray-600 transition-colors">Terms of Service</Link>
        </div>
      </div>
    </main>
  );
}
