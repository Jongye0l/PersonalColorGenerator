'use client'

import React from 'react';
import {useRouter} from 'next/navigation';

export default function PersonalColorIntro() {
    const router = useRouter();

    return (
        <div className="flex justify-center items-center min-h-screen bg-gray-100 font-sans">
            <div className="relative w-full max-w-[430px] h-[932px] bg-white shadow-lg overflow-hidden flex flex-col justify-between p-6">
                <main className="flex-1 flex flex-col items-center justify-center text-center px-4">
                    <div
                        className="flex items-center justify-center gap-1 mb-16 text-3xl font-bold text-black tracking-tight">
                        <span>반갑습니다</span>
                        <span className="text-3xl animate-bounce-short">✋</span>
                    </div>

                    <div className="space-y-3 text-[15px] font-normal leading-relaxed text-gray-900 tracking-normal">
                        <p>AI가 분석하는 나만의 퍼스널 컬러</p>
                        <p>
                            당신에게 가장 잘 어울리는<br/>
                            퍼스널 컬러를 찾아보세요.
                        </p>
                    </div>
                </main>

                <footer className="w-full pb-12 px-4">
                    <button
                        onClick={() => router.push('/Diagnosis')}
                        className="w-full py-4 bg-black text-white text-base font-semibold rounded-xl active:scale-[0.98] transition-transform duration-150 tracking-wide"
                    >
                        진단하기
                    </button>
                </footer>

            </div>
        </div>
    );
}