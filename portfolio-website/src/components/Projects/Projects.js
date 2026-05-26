import React from 'react';
import { motion } from 'framer-motion';
import { FiGithub, FiExternalLink, FiFolder } from 'react-icons/fi';
import './Projects.css';

const Projects = () => {
  const featuredProjects = [
    {
      title: 'CloudFlow Dashboard',
      description:
        'A comprehensive cloud infrastructure monitoring dashboard with real-time metrics, interactive charts, and customizable widgets. Built with performance in mind, handling 10,000+ data points with smooth 60fps animations.',
      tech: ['React', 'TypeScript', 'D3.js', 'WebSocket', 'Tailwind CSS'],
      github: 'https://github.com',
      live: 'https://example.com',
      image: null,
    },
    {
      title: 'DesignSystem Pro',
      description:
        'An enterprise-grade design system with 60+ accessible, themeable components. Features auto-generated documentation, visual regression testing, and Figma integration for seamless designer-developer handoff.',
      tech: ['React', 'Storybook', 'Styled Components', 'Jest', 'Chromatic'],
      github: 'https://github.com',
      live: 'https://example.com',
      image: null,
    },
    {
      title: 'EcoTrack Mobile',
      description:
        'A progressive web app for tracking personal carbon footprint with gamification elements. Features offline support, push notifications, and social sharing. Achieved 98/100 Lighthouse performance score.',
      tech: ['Next.js', 'PWA', 'Chart.js', 'Firebase', 'Framer Motion'],
      github: 'https://github.com',
      live: 'https://example.com',
      image: null,
    },
  ];

  const otherProjects = [
    {
      title: 'Markdown Editor Pro',
      description: 'A feature-rich markdown editor with live preview, syntax highlighting, and export to PDF/HTML functionality.',
      tech: ['React', 'CodeMirror', 'Marked.js'],
      github: 'https://github.com',
      live: 'https://example.com',
    },
    {
      title: 'Weather Viz',
      description: 'Beautiful weather visualization app with animated backgrounds that change based on current conditions.',
      tech: ['Vue.js', 'Three.js', 'OpenWeather API'],
      github: 'https://github.com',
      live: 'https://example.com',
    },
    {
      title: 'Portfolio Generator',
      description: 'A CLI tool that generates customizable portfolio websites from a JSON configuration file.',
      tech: ['Node.js', 'EJS', 'Commander.js'],
      github: 'https://github.com',
      live: null,
    },
    {
      title: 'A11y Audit Tool',
      description: 'Automated accessibility audit tool that scans websites and generates comprehensive WCAG compliance reports.',
      tech: ['TypeScript', 'Puppeteer', 'axe-core'],
      github: 'https://github.com',
      live: 'https://example.com',
    },
    {
      title: 'Component Playground',
      description: 'Interactive playground for prototyping React components with real-time prop editing and code export.',
      tech: ['React', 'Monaco Editor', 'Babel'],
      github: 'https://github.com',
      live: 'https://example.com',
    },
    {
      title: 'CSS Animation Library',
      description: 'Lightweight CSS animation library with 50+ production-ready animations and a visual configuration tool.',
      tech: ['CSS', 'JavaScript', 'Rollup'],
      github: 'https://github.com',
      live: 'https://example.com',
    },
  ];

  return (
    <section className="projects section" id="projects">
      <div className="container">
        <h2 className="section-heading">
          <span className="number">03.</span> Featured Projects
        </h2>

        <div className="projects__featured">
          {featuredProjects.map((project, index) => (
            <motion.div
              key={project.title}
              className={`projects__featured-item ${index % 2 !== 0 ? 'projects__featured-item--reverse' : ''}`}
              initial={{ opacity: 0, y: 40 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6 }}
            >
              <div className="projects__featured-image">
                <div className="projects__featured-placeholder">
                  <FiFolder className="projects__featured-placeholder-icon" />
                  <span>{project.title}</span>
                </div>
              </div>
              <div className="projects__featured-content">
                <p className="projects__featured-overline">Featured Project</p>
                <h3 className="projects__featured-title">{project.title}</h3>
                <div className="projects__featured-description">
                  <p>{project.description}</p>
                </div>
                <ul className="projects__featured-tech">
                  {project.tech.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
                <div className="projects__featured-links">
                  <a href={project.github} target="_blank" rel="noopener noreferrer" aria-label="GitHub">
                    <FiGithub />
                  </a>
                  <a href={project.live} target="_blank" rel="noopener noreferrer" aria-label="Live Demo">
                    <FiExternalLink />
                  </a>
                </div>
              </div>
            </motion.div>
          ))}
        </div>

        <h3 className="projects__other-heading">Other Noteworthy Projects</h3>
        <div className="projects__other-grid">
          {otherProjects.map((project, index) => (
            <motion.div
              key={project.title}
              className="projects__other-card"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.4, delay: index * 0.1 }}
            >
              <div className="projects__other-top">
                <FiFolder className="projects__other-folder" />
                <div className="projects__other-links">
                  {project.github && (
                    <a href={project.github} target="_blank" rel="noopener noreferrer" aria-label="GitHub">
                      <FiGithub />
                    </a>
                  )}
                  {project.live && (
                    <a href={project.live} target="_blank" rel="noopener noreferrer" aria-label="Live Demo">
                      <FiExternalLink />
                    </a>
                  )}
                </div>
              </div>
              <h4 className="projects__other-title">{project.title}</h4>
              <p className="projects__other-description">{project.description}</p>
              <ul className="projects__other-tech">
                {project.tech.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default Projects;
