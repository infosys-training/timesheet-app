import React, { useState } from 'react';
import { motion } from 'framer-motion';
import './Experience.css';

const Experience = () => {
  const [activeTab, setActiveTab] = useState(0);

  const experiences = [
    {
      company: 'TechVision Labs',
      role: 'Senior UI Developer',
      period: 'Jan 2022 — Present',
      url: 'https://example.com',
      points: [
        'Lead a team of 5 frontend developers building a next-generation SaaS analytics platform serving 50,000+ users.',
        'Architected a micro-frontend system using Module Federation, reducing deployment time by 60% and enabling independent team releases.',
        'Implemented a comprehensive design system with 80+ reusable components, improving development velocity by 40%.',
        'Spearheaded the migration from JavaScript to TypeScript across 200+ components, reducing production bugs by 35%.',
        'Optimized Core Web Vitals, achieving a 45% improvement in LCP and reducing CLS to near-zero.',
      ],
    },
    {
      company: 'Nexus Digital',
      role: 'UI Developer',
      period: 'Mar 2019 — Dec 2021',
      url: 'https://example.com',
      points: [
        'Built and maintained responsive web applications for Fortune 500 clients in finance, healthcare, and e-commerce sectors.',
        'Developed a real-time collaborative document editor using React, WebSocket, and operational transformation algorithms.',
        'Created reusable animation libraries using Framer Motion, adopted by 3 internal teams across the organization.',
        'Mentored 4 junior developers, conducting code reviews and establishing frontend best practices documentation.',
        'Reduced bundle size by 52% through code splitting, tree shaking, and dynamic imports.',
      ],
    },
    {
      company: 'PixelCraft Agency',
      role: 'Frontend Developer',
      period: 'Jun 2017 — Feb 2019',
      url: 'https://example.com',
      points: [
        'Developed pixel-perfect, responsive websites for 20+ clients across various industries including fashion, food, and tech.',
        'Built custom WordPress themes and headless CMS solutions using React and Gatsby.',
        'Implemented complex CSS animations and interactive experiences that increased user engagement by 30%.',
        'Collaborated closely with UX designers to translate wireframes and prototypes into production-ready code.',
      ],
    },
    {
      company: 'StartupHub',
      role: 'Junior Developer',
      period: 'Aug 2016 — May 2017',
      url: 'https://example.com',
      points: [
        'Contributed to building an MVP for a social learning platform using React and Node.js.',
        'Implemented responsive UI components following Material Design guidelines.',
        'Participated in agile ceremonies and contributed to sprint planning and retrospectives.',
        'Wrote unit and integration tests achieving 85% code coverage across frontend modules.',
      ],
    },
  ];

  return (
    <section className="experience section" id="experience">
      <div className="container">
        <h2 className="section-heading">
          <span className="number">04.</span> Where I've Worked
        </h2>
        <div className="experience__content">
          <div className="experience__tabs" role="tablist">
            {experiences.map((exp, index) => (
              <button
                key={exp.company}
                className={`experience__tab ${activeTab === index ? 'experience__tab--active' : ''}`}
                onClick={() => setActiveTab(index)}
                role="tab"
                aria-selected={activeTab === index}
              >
                {exp.company}
              </button>
            ))}
            <div
              className="experience__tab-indicator"
              style={{ transform: `translateY(${activeTab * 42}px)` }}
            />
          </div>

          <motion.div
            className="experience__panel"
            key={activeTab}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.3 }}
            role="tabpanel"
          >
            <h3 className="experience__title">
              {experiences[activeTab].role}{' '}
              <a
                href={experiences[activeTab].url}
                className="experience__company"
                target="_blank"
                rel="noopener noreferrer"
              >
                @ {experiences[activeTab].company}
              </a>
            </h3>
            <p className="experience__period">{experiences[activeTab].period}</p>
            <ul className="experience__points">
              {experiences[activeTab].points.map((point) => (
                <li key={point} className="experience__point">
                  {point}
                </li>
              ))}
            </ul>
          </motion.div>
        </div>
      </div>
    </section>
  );
};

export default Experience;
