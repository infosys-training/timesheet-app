import React from 'react';
import { motion } from 'framer-motion';
import {
  FiLayout, FiSmartphone, FiZap, FiLayers,
  FiCode, FiGlobe, FiDatabase, FiGitBranch,
} from 'react-icons/fi';
import './Skills.css';

const Skills = () => {
  const skillCategories = [
    {
      icon: <FiLayout />,
      title: 'Frontend Architecture',
      description: 'Building scalable, maintainable component architectures with React, Next.js, and modern state management.',
      skills: [
        { name: 'React.js', level: 95 },
        { name: 'Next.js', level: 90 },
        { name: 'TypeScript', level: 92 },
        { name: 'Redux / Zustand', level: 88 },
      ],
    },
    {
      icon: <FiSmartphone />,
      title: 'Responsive Design',
      description: 'Crafting fluid, mobile-first layouts that look stunning across all devices and screen sizes.',
      skills: [
        { name: 'CSS3 / SCSS', level: 96 },
        { name: 'Tailwind CSS', level: 93 },
        { name: 'CSS-in-JS', level: 85 },
        { name: 'Responsive Design', level: 97 },
      ],
    },
    {
      icon: <FiZap />,
      title: 'Performance',
      description: 'Optimizing web vitals, bundle sizes, and rendering performance for lightning-fast experiences.',
      skills: [
        { name: 'Web Vitals', level: 90 },
        { name: 'Lighthouse', level: 92 },
        { name: 'Lazy Loading', level: 88 },
        { name: 'Code Splitting', level: 87 },
      ],
    },
    {
      icon: <FiLayers />,
      title: 'UI/UX Design',
      description: 'Translating Figma designs into pixel-perfect components with smooth animations and micro-interactions.',
      skills: [
        { name: 'Figma', level: 88 },
        { name: 'Framer Motion', level: 85 },
        { name: 'Design Systems', level: 90 },
        { name: 'Accessibility', level: 92 },
      ],
    },
    {
      icon: <FiCode />,
      title: 'Testing & Quality',
      description: 'Ensuring reliability with comprehensive unit, integration, and end-to-end testing strategies.',
      skills: [
        { name: 'Jest', level: 88 },
        { name: 'React Testing Library', level: 86 },
        { name: 'Cypress', level: 82 },
        { name: 'Storybook', level: 84 },
      ],
    },
    {
      icon: <FiGlobe />,
      title: 'API Integration',
      description: 'Seamlessly connecting frontends with RESTful and GraphQL APIs with proper error handling.',
      skills: [
        { name: 'REST APIs', level: 92 },
        { name: 'GraphQL', level: 85 },
        { name: 'WebSockets', level: 80 },
        { name: 'React Query', level: 87 },
      ],
    },
    {
      icon: <FiDatabase />,
      title: 'Backend Basics',
      description: 'Building lightweight APIs and server-side rendering solutions when needed.',
      skills: [
        { name: 'Node.js', level: 80 },
        { name: 'Express', level: 78 },
        { name: 'MongoDB', level: 72 },
        { name: 'PostgreSQL', level: 70 },
      ],
    },
    {
      icon: <FiGitBranch />,
      title: 'DevOps & Tools',
      description: 'Streamlining development workflows with modern tooling and CI/CD pipelines.',
      skills: [
        { name: 'Git', level: 92 },
        { name: 'Webpack / Vite', level: 85 },
        { name: 'Docker', level: 75 },
        { name: 'CI/CD', level: 80 },
      ],
    },
  ];

  return (
    <section className="skills section" id="skills">
      <div className="container">
        <h2 className="section-heading">
          <span className="number">02.</span> Skills & Expertise
        </h2>
        <div className="skills__grid">
          {skillCategories.map((category, index) => (
            <motion.div
              key={category.title}
              className="skills__card"
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: index * 0.1 }}
            >
              <div className="skills__card-icon">{category.icon}</div>
              <h3 className="skills__card-title">{category.title}</h3>
              <p className="skills__card-description">{category.description}</p>
              <div className="skills__bars">
                {category.skills.map((skill) => (
                  <div key={skill.name} className="skills__bar-item">
                    <div className="skills__bar-header">
                      <span className="skills__bar-name">{skill.name}</span>
                      <span className="skills__bar-percent">{skill.level}%</span>
                    </div>
                    <div className="skills__bar-track">
                      <motion.div
                        className="skills__bar-fill"
                        initial={{ width: 0 }}
                        whileInView={{ width: `${skill.level}%` }}
                        viewport={{ once: true }}
                        transition={{ duration: 1, delay: 0.3 }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default Skills;
