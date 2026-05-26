import React from 'react';
import Link from 'next/link';

/** Public marketing homepage — always statically generated for reliable Vercel routing. */
export const dynamic = 'force-static';
import { 
  ChevronDown, 
  CheckCircle2, 
  Bot, 
  Calendar, 
  MessageSquare, 
  Users, 
  FileText, 
  BarChart3, 
  ArrowRight,
  ClipboardList,
  UserCheck,
  Target,
  Zap,
  Linkedin,
  Facebook,
  Twitter,
  Youtube,
  Video,
  TrendingUp
} from 'lucide-react';

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-white text-slate-900 font-sans selection:bg-orange-100 selection:text-orange-900">
      {/* Navigation */}
      <nav className="border-b border-gray-100 sticky top-0 bg-white/80 backdrop-blur-md z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-20 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative flex items-center justify-center w-8 h-8">
              <div className="absolute inset-0 bg-gradient-to-br from-[#FF5A1F] to-[#E03A00] rounded-lg transform rotate-45"></div>
              <span className="relative text-white font-bold text-xl drop-shadow-md">A</span>
            </div>
            <span className="font-bold text-2xl tracking-tight text-gray-900">AIRIS</span>
          </div>
          
          <div className="hidden md:flex items-center space-x-8">
          </div>


          <div className="hidden md:flex items-center space-x-4">
            <Link href="/login" className="text-sm font-medium text-gray-700 hover:text-gray-900 transition-colors">
              Log in
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="relative pt-16 pb-16 lg:pt-24 lg:pb-32">
        <style>
          {`
            @keyframes drawLine {
              to {
                stroke-dashoffset: 0;
              }
            }
            .animate-draw-1 {
              stroke-dasharray: 250;
              stroke-dashoffset: 250;
              animation: drawLine 1s ease-out forwards;
              animation-delay: 0.2s;
            }
            .animate-draw-2 {
              stroke-dasharray: 200;
              stroke-dashoffset: 200;
              animation: drawLine 1s ease-out forwards;
              animation-delay: 0.5s;
            }
            .animate-draw-3 {
              stroke-dasharray: 100;
              stroke-dashoffset: 100;
              animation: drawLine 0.8s ease-out forwards;
              animation-delay: 0.8s;
            }
          `}
        </style>
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full h-[500px] bg-[radial-gradient(ellipse_at_top,rgba(255,90,31,0.05)_0%,rgba(255,255,255,0)_70%)] pointer-events-none"></div>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col lg:flex-row items-center justify-between gap-12 lg:gap-4">
          <div className="w-full lg:w-[45%] max-w-2xl">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-orange-50/80 border border-orange-100 text-[#FF5A1F] text-xs font-semibold mb-6">
              <Zap className="w-3.5 h-3.5" fill="currentColor" />
              <span>AI-Powered Recruiting Operating System</span>
            </div>
            <h1 className="text-5xl sm:text-6xl lg:text-[64px] font-bold tracking-tight text-[#111827] mb-8 leading-[1.05]">
              Hire faster.<br />
              Smarter.<br />
              <span className="relative inline-block text-[#FF5A1F]">
                At scale.
                <svg className="absolute w-[110%] h-8 -bottom-5 -left-2 pointer-events-none" viewBox="0 0 200 30" preserveAspectRatio="none">
                  <defs>
                    <linearGradient id="goldGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                      <stop offset="0%" stopColor="#FFB74D" />
                      <stop offset="30%" stopColor="#FF5A1F" />
                      <stop offset="70%" stopColor="#E03A00" />
                      <stop offset="100%" stopColor="#FFB74D" />
                    </linearGradient>
                  </defs>
                  {/* Top main stroke */}
                  <path 
                    d="M 5 12 Q 50 6, 100 10 T 195 8" 
                    stroke="url(#goldGradient)" 
                    strokeWidth="4" 
                    fill="none" 
                    strokeLinecap="round" 
                    className="animate-draw-1"
                  />
                  {/* Middle thin stroke */}
                  <path 
                    d="M 15 20 Q 80 16, 140 20 T 185 18" 
                    stroke="url(#goldGradient)" 
                    strokeWidth="2.5" 
                    fill="none" 
                    strokeLinecap="round" 
                    opacity="0.8"
                    className="animate-draw-2"
                  />
                  {/* Bottom tiny flourish stroke */}
                  <path 
                    d="M 30 27 Q 60 25, 90 27 T 120 25" 
                    stroke="url(#goldGradient)" 
                    strokeWidth="1.5" 
                    fill="none" 
                    strokeLinecap="round" 
                    opacity="0.6"
                    className="animate-draw-3"
                  />
                </svg>
              </span>
            </h1>
            <p className="text-base xl:text-lg text-gray-600 leading-relaxed max-w-lg font-medium relative z-10">
              AIRIS is the AI-native recruiting operating system that automates everything from sourcing to placement. Deploy autonomous AI agents to screen, interview, and engage talent at scale.
            </p>
          </div>
          
          <div className="w-full lg:w-[55%] relative flex justify-center items-center">
            <div className="relative w-full max-w-[550px] aspect-square mt-8 lg:mt-0">
              {/* Outer dashed ring */}
              <svg className="absolute inset-4 w-[calc(100%-2rem)] h-[calc(100%-2rem)] pointer-events-none" viewBox="0 0 100 100">
                <circle cx="50" cy="50" r="40" fill="none" stroke="#FF5A1F" strokeWidth="0.25" strokeDasharray="1 2.5" opacity="0.6" />
              </svg>
              {/* Inner solid faint ring */}
              <div className="absolute inset-20 rounded-full border border-gray-100 shadow-sm opacity-60"></div>
              
              {/* Small orange dots on the outer ring */}
              <div className="absolute inset-0 w-full h-full animate-[spin_60s_linear_infinite]">
                 {/* 30 deg */}
                 <div className="absolute w-1.5 h-1.5 bg-[#FF5A1F] rounded-full" style={{ left: '70%', top: '15.4%', transform: 'translate(-50%, -50%)' }}></div>
                 {/* 90 deg */}
                 <div className="absolute w-1.5 h-1.5 bg-[#FF5A1F] rounded-full" style={{ left: '90%', top: '50%', transform: 'translate(-50%, -50%)' }}></div>
                 {/* 150 deg */}
                 <div className="absolute w-1.5 h-1.5 bg-[#FF5A1F] rounded-full" style={{ left: '70%', top: '84.6%', transform: 'translate(-50%, -50%)' }}></div>
                 {/* 210 deg */}
                 <div className="absolute w-1.5 h-1.5 bg-[#FF5A1F] rounded-full" style={{ left: '30%', top: '84.6%', transform: 'translate(-50%, -50%)' }}></div>
                 {/* 270 deg */}
                 <div className="absolute w-1.5 h-1.5 bg-[#FF5A1F] rounded-full" style={{ left: '10%', top: '50%', transform: 'translate(-50%, -50%)' }}></div>
                 {/* 330 deg */}
                 <div className="absolute w-1.5 h-1.5 bg-[#FF5A1F] rounded-full" style={{ left: '30%', top: '15.4%', transform: 'translate(-50%, -50%)' }}></div>
              </div>

              {/* Center Logo - Restored to the Official AIRIS Logo */}
              <div className="absolute inset-0 m-auto w-[150px] h-[150px] bg-white rounded-full shadow-[0_0_80px_-15px_rgba(255,90,31,0.2)] flex items-center justify-center z-10 border border-gray-50">
                 <div className="relative flex items-center justify-center w-16 h-16">
                    <div className="absolute inset-0 bg-gradient-to-br from-[#FF5A1F] to-[#E03A00] rounded-2xl transform rotate-45 shadow-sm"></div>
                    <span className="relative text-white font-bold text-[40px] drop-shadow-sm">A</span>
                  </div>
              </div>

              {/* Floating Icons exactly placed in a hexagon with text */}
              <div className="absolute top-[10%] left-[50%] -translate-x-1/2 -translate-y-1/2 w-24 h-24 sm:w-[110px] sm:h-[110px] bg-white rounded-2xl shadow-[0_8px_30px_-5px_rgba(0,0,0,0.06)] flex flex-col items-center justify-center text-gray-800 z-20 animate-bounce" style={{ animationDuration: '3s' }}>
                <Bot className="w-6 h-6 sm:w-7 sm:h-7 mb-2 text-gray-700" strokeWidth={1.5} />
                <span className="text-[9px] sm:text-[10px] font-bold text-center leading-tight text-gray-800">AI Screening</span>
              </div>
              <div className="absolute top-[30%] left-[84.6%] -translate-x-1/2 -translate-y-1/2 w-24 h-24 sm:w-[110px] sm:h-[110px] bg-white rounded-2xl shadow-[0_8px_30px_-5px_rgba(0,0,0,0.06)] flex flex-col items-center justify-center text-gray-800 z-20 animate-bounce" style={{ animationDuration: '4s', animationDelay: '0.5s' }}>
                <BarChart3 className="w-6 h-6 sm:w-7 sm:h-7 mb-2 text-gray-700" strokeWidth={1.5} />
                <span className="text-[9px] sm:text-[10px] font-bold text-center leading-tight text-gray-800">Predictive<br/>Insights</span>
              </div>
              <div className="absolute top-[70%] left-[84.6%] -translate-x-1/2 -translate-y-1/2 w-24 h-24 sm:w-[110px] sm:h-[110px] bg-white rounded-2xl shadow-[0_8px_30px_-5px_rgba(0,0,0,0.06)] flex flex-col items-center justify-center text-gray-800 z-20 animate-bounce" style={{ animationDuration: '3.5s', animationDelay: '1s' }}>
                <MessageSquare className="w-6 h-6 sm:w-7 sm:h-7 mb-2 text-gray-700" strokeWidth={1.5} />
                <span className="text-[9px] sm:text-[10px] font-bold text-center leading-tight text-gray-800">Omnichannel<br/>Engagement</span>
              </div>
              <div className="absolute top-[90%] left-[50%] -translate-x-1/2 -translate-y-1/2 w-24 h-24 sm:w-[110px] sm:h-[110px] bg-white rounded-2xl shadow-[0_8px_30px_-5px_rgba(0,0,0,0.06)] flex flex-col items-center justify-center text-gray-800 z-20 animate-bounce" style={{ animationDuration: '4.5s', animationDelay: '1.5s' }}>
                <FileText className="w-6 h-6 sm:w-7 sm:h-7 mb-2 text-gray-700" strokeWidth={1.5} />
                <span className="text-[9px] sm:text-[10px] font-bold text-center leading-tight text-gray-800">Agentic<br/>Sourcing</span>
              </div>
              <div className="absolute top-[70%] left-[15.4%] -translate-x-1/2 -translate-y-1/2 w-24 h-24 sm:w-[110px] sm:h-[110px] bg-white rounded-2xl shadow-[0_8px_30px_-5px_rgba(0,0,0,0.06)] flex flex-col items-center justify-center text-gray-800 z-20 animate-bounce" style={{ animationDuration: '3.2s', animationDelay: '2s' }}>
                <Video className="w-6 h-6 sm:w-7 sm:h-7 mb-2 text-gray-700" strokeWidth={1.5} />
                <span className="text-[9px] sm:text-[10px] font-bold text-center leading-tight text-gray-800">AI<br/>Interviewer</span>
              </div>
              <div className="absolute top-[30%] left-[15.4%] -translate-x-1/2 -translate-y-1/2 w-24 h-24 sm:w-[110px] sm:h-[110px] bg-white rounded-2xl shadow-[0_8px_30px_-5px_rgba(0,0,0,0.06)] flex flex-col items-center justify-center text-gray-800 z-20 animate-bounce" style={{ animationDuration: '3.8s', animationDelay: '2.5s' }}>
                <Users className="w-6 h-6 sm:w-7 sm:h-7 mb-2 text-gray-700" strokeWidth={1.5} />
                <span className="text-[9px] sm:text-[10px] font-bold text-center leading-tight text-gray-800">AI<br/>Assessments</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Why AIRIS Section */}
      <section className="py-24 bg-gray-50 border-y border-gray-100">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h3 className="text-[#FF5A1F] font-bold tracking-wider text-sm uppercase mb-4">Why AIRIS?</h3>
            <h2 className="text-4xl md:text-5xl font-extrabold text-gray-900 max-w-3xl mx-auto leading-tight">
              Everything you need to run your recruiting business, <span className="text-[#FF5A1F]">powered by AI</span>
            </h2>
          </div>

          <div className="grid md:grid-cols-3 lg:grid-cols-6 gap-6">
            {[
              { icon: Bot, title: "AI Screening Agent", desc: "Instantly parse resumes, extract skills, and rank candidates using advanced semantic matching." },
              { icon: Video, title: "AI Interviewer", desc: "Autonomous AI agents conduct voice and video interviews, assessing soft skills and technical fit." },
              { icon: Target, title: "Autonomous Sourcing", desc: "AI agents proactively find and engage top-tier talent from across the web and social platforms." },
              { icon: Calendar, title: "Smart Scheduling", desc: "Seamless calendar sync and AI-driven coordination to eliminate back-and-forth emails." },
              { icon: FileText, title: "AI Assessments", desc: "Dynamic skill tests and behavioral evaluations with automated scoring and insights." },
              { icon: Zap, title: "Agentic Workflows", desc: "Automate complex hiring processes with AI agents that handle multi-step tasks independently." }
            ].map((feature, i) => (
              <div key={i} className="bg-white p-6 rounded-3xl shadow-sm border border-gray-100 hover:shadow-md transition-shadow group flex flex-col items-center text-center">
                <div className="w-14 h-14 bg-orange-50 rounded-2xl flex items-center justify-center mb-6 group-hover:bg-[#FF5A1F] transition-colors">
                  <feature.icon className="w-7 h-7 text-[#FF5A1F] group-hover:text-white transition-colors" />
                </div>
                <h4 className="text-lg font-bold text-gray-900 mb-3">{feature.title}</h4>
                <p className="text-sm text-gray-500 leading-relaxed">{feature.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* AI AT EVERY STEP Section */}
      <section className="py-32 overflow-hidden">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 grid lg:grid-cols-2 gap-20 items-center">
          <div>
            <h3 className="text-[#FF5A1F] font-bold tracking-wider text-sm uppercase mb-4">AI AT EVERY STEP</h3>
            <h2 className="text-4xl md:text-5xl font-extrabold text-gray-900 mb-8 leading-tight">
              From sourcing to placement, AI works with you.
            </h2>
            <div className="space-y-5 mb-10">
              {[
                "Autonomous video & voice interviews",
                "Advanced semantic candidate matching",
                "Automated scheduling & coordination",
                "Real-time sentiment & soft-skill analysis",
                "Predictive placement probability scoring"
              ].map((item, i) => (
                <div key={i} className="flex items-center gap-4">
                  <div className="flex-shrink-0 w-6 h-6 rounded-full bg-[#FF5A1F] flex items-center justify-center">
                    <CheckCircle2 className="w-4 h-4 text-white" />
                  </div>
                  <span className="text-lg font-medium text-gray-700">{item}</span>
                </div>
              ))}
            </div>
            <Link href="#" className="inline-flex items-center text-[#FF5A1F] font-bold text-lg hover:text-[#E04B15] transition-colors">
              Explore all features <ArrowRight className="ml-2 w-5 h-5" />
            </Link>
          </div>

          <div className="relative w-full aspect-[5/4] hidden lg:block max-w-[900px] mx-auto">
             {/* Connecting Lines Behind */}
             <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 1000 800" style={{ zIndex: 0 }}>
               <defs>
                  <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                     <path d="M 0 2 L 8 5 L 0 8 z" fill="#FF5A1F" />
                  </marker>
               </defs>
               
               <g stroke="#FF5A1F" strokeWidth="2" strokeDasharray="6 4" fill="none" markerEnd="url(#arrow)">
                 {/* Left paths */}
                 <path d="M 350 80 L 365 80 A 15 15 0 0 1 380 95 L 380 385 A 15 15 0 0 0 395 400 L 410 400" />
                 <path d="M 350 240 L 365 240 A 15 15 0 0 1 380 255 L 380 385 A 15 15 0 0 0 395 400 L 410 400" />
                 <path d="M 350 400 L 410 400" />
                 <path d="M 350 560 L 365 560 A 15 15 0 0 0 380 545 L 380 415 A 15 15 0 0 1 395 400 L 410 400" />
                 <path d="M 350 720 L 365 720 A 15 15 0 0 0 380 705 L 380 415 A 15 15 0 0 1 395 400 L 410 400" />

                 {/* Right paths */}
                 <path d="M 590 400 L 605 400 A 15 15 0 0 0 620 385 L 620 95 A 15 15 0 0 1 635 80 L 650 80" />
                 <path d="M 590 400 L 605 400 A 15 15 0 0 0 620 385 L 620 255 A 15 15 0 0 1 635 240 L 650 240" />
                 <path d="M 590 400 L 650 400" />
                 <path d="M 590 400 L 605 400 A 15 15 0 0 1 620 415 L 620 545 A 15 15 0 0 0 635 560 L 650 560" />
                 <path d="M 590 400 L 605 400 A 15 15 0 0 1 620 415 L 620 705 A 15 15 0 0 0 635 720 L 650 720" />
               </g>
             </svg>

             {/* Left Side Inputs */}
             <div className="absolute left-0 top-[5%] bottom-[5%] w-[35%] flex flex-col justify-between z-10">
                {[
                  { icon: ClipboardList, label: "Job Requirements" },
                  { icon: UserCheck, label: "Candidate Profiles" },
                  { icon: Target, label: "Skill Assessments" },
                  { icon: Video, label: "Autonomous Interviews" },
                  { icon: Zap, label: "Agentic Sourcing" }
                ].map((item, i) => (
                  <div key={i} className="flex items-center gap-4 bg-white px-5 rounded-2xl border border-gray-100 shadow-[0_2px_15px_-3px_rgba(0,0,0,0.05)] w-full h-[10%] min-h-[50px]">
                    <item.icon className="w-5 h-5 text-gray-800 shrink-0" strokeWidth={1.5} />
                    <span className="text-[13px] xl:text-[14px] font-semibold text-gray-900">{item.label}</span>
                  </div>
                ))}
             </div>

             {/* Center AI */}
             <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[18%] aspect-square bg-white rounded-full flex items-center justify-center shadow-[0_0_80px_-15px_rgba(255,90,31,0.25)] z-20 border border-orange-100">
                <span className="text-4xl xl:text-6xl font-black tracking-tight text-[#FF5A1F]">AI</span>
             </div>

             {/* Right Side Outputs */}
             <div className="absolute right-0 top-[5%] bottom-[5%] w-[35%] flex flex-col justify-between z-10">
                {[
                  { icon: Users, label: "Shortlisted Talent", sub: "Top 1% matched" },
                  { icon: FileText, label: "Behavioral Analysis", sub: "Psychometric insights" },
                  { icon: UserCheck, label: "AI Interview Score", sub: "Objective evaluation" },
                  { icon: Target, label: "Placement Probability", sub: "98% accuracy" },
                  { icon: Zap, label: "Automated Offer", sub: "Ready for signature" }
                ].map((item, i) => (
                  <div key={i} className="flex items-center gap-4 bg-white px-5 rounded-2xl border border-gray-100 shadow-[0_2px_15px_-3px_rgba(0,0,0,0.05)] w-full h-[10%] min-h-[50px]">
                    <item.icon className="w-5 h-5 text-gray-800 shrink-0" strokeWidth={1.5} />
                    <div className="flex-1">
                      <div className="text-[13px] xl:text-[14px] font-bold text-gray-900 leading-tight mb-0.5">{item.label}</div>
                      <div className="text-[11px] xl:text-[12px] text-gray-500 font-medium">{item.sub}</div>
                    </div>
                  </div>
                ))}
             </div>
          </div>
        </div>
      </section>




      {/* Footer */}
      <footer className="bg-white pt-20 pb-10 border-t border-gray-100">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-12 mb-16">
            <div className="lg:col-span-2">
              <div className="flex items-center gap-2 mb-6">
                <div className="relative flex items-center justify-center w-8 h-8">
                  <div className="absolute inset-0 bg-gradient-to-br from-[#FF5A1F] to-[#E03A00] rounded-lg transform rotate-45"></div>
                  <span className="relative text-white font-bold text-xl drop-shadow-md">A</span>
                </div>
                <span className="font-bold text-2xl tracking-tight text-gray-900">AIRIS</span>
              </div>
              <p className="text-gray-500 mb-8 max-w-sm leading-relaxed">
                The AI-powered recruiting operating system for staffing and recruiting agencies.
              </p>
              <div className="flex items-center gap-4">
                <a href="#" className="w-10 h-10 rounded-full bg-gray-50 flex items-center justify-center text-gray-400 hover:text-[#FF5A1F] hover:bg-orange-50 transition-colors">
                  <Linkedin className="w-5 h-5" />
                </a>
                <a href="#" className="w-10 h-10 rounded-full bg-gray-50 flex items-center justify-center text-gray-400 hover:text-[#FF5A1F] hover:bg-orange-50 transition-colors">
                  <Facebook className="w-5 h-5" />
                </a>
                <a href="#" className="w-10 h-10 rounded-full bg-gray-50 flex items-center justify-center text-gray-400 hover:text-[#FF5A1F] hover:bg-orange-50 transition-colors">
                  <Twitter className="w-5 h-5" />
                </a>
                <a href="#" className="w-10 h-10 rounded-full bg-gray-50 flex items-center justify-center text-gray-400 hover:text-[#FF5A1F] hover:bg-orange-50 transition-colors">
                  <Youtube className="w-5 h-5" />
                </a>
              </div>
            </div>

            <div>
              <h4 className="font-bold text-gray-900 mb-6">Company</h4>
              <ul className="space-y-4">
                <li><a href="#" className="text-gray-500 hover:text-[#FF5A1F] transition-colors">About Us</a></li>
                <li><a href="#" className="text-gray-500 hover:text-[#FF5A1F] transition-colors">Careers</a></li>
                <li><a href="#" className="text-gray-500 hover:text-[#FF5A1F] transition-colors">Contact Us</a></li>
                <li><a href="#" className="text-gray-500 hover:text-[#FF5A1F] transition-colors">Privacy Policy</a></li>
              </ul>
            </div>
          </div>

          <div className="pt-8 border-t border-gray-100 flex flex-col md:flex-row items-center justify-between gap-4">
            <p className="text-gray-400 text-sm">© {new Date().getFullYear()} AIRIS. All rights reserved.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
