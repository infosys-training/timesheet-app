import React from 'react';
import { motion } from 'framer-motion';
import { FiArrowRight } from 'react-icons/fi';
import './About.css';

const About = () => {
  const technologies = [
    'React.js / Next.js',
    'TypeScript',
    'JavaScript (ES6+)',
    'Vue.js / Nuxt.js',
    'Tailwind CSS / SCSS',
    'Framer Motion',
    'GraphQL / REST APIs',
    'Node.js / Express',
    'Figma / Adobe XD',
    'Jest / Cypress',
    'Webpack / Vite',
    'Git / CI/CD',
  ];

  return (
    <section className="about section" id="about">
      <div className="container">
        <h2 className="section-heading">
          <span className="number">01.</span> About Me
        </h2>
        <div className="about__grid">
          <motion.div
            className="about__text"
            initial={{ opacity: 0, x: -30 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
          >
            <p>
              Hello! I'm Alex, a passionate UI developer with over <strong>8 years</strong> of
              experience crafting beautiful, responsive, and user-centric web
              applications. My journey into web development began when I
              customized my first WordPress theme — I was instantly hooked by the
              power of transforming designs into living, interactive experiences.
            </p>
            <p>
              Fast-forward to today, I've had the privilege of working at{' '}
              <a href="#experience" className="about__link">a design agency</a>,{' '}
              <a href="#experience" className="about__link">a Fortune 500 company</a>,{' '}
              <a href="#experience" className="about__link">a fast-growing startup</a>, and{' '}
              <a href="#experience" className="about__link">a leading tech consultancy</a>.
              My main focus these days is building accessible, inclusive products
              and digital experiences that delight users while maintaining
              rock-solid performance.
            </p>
            <p>
              I believe in the intersection of design and engineering — where
              clean code meets stunning visuals. When I'm not coding, you'll find
              me contributing to open-source projects, writing technical articles,
              or speaking at developer conferences.
            </p>
            <p className="about__tech-intro">
              Here are some technologies I work with regularly:
            </p>
            <ul className="about__tech-list">
              {technologies.map((tech) => (
                <li key={tech} className="about__tech-item">
                  <FiArrowRight className="about__tech-icon" />
                  {tech}
                </li>
              ))}
            </ul>
          </motion.div>
          <motion.div
            className="about__image-wrapper"
            initial={{ opacity: 0, x: 30 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
          >
            <div className="about__image-container">
              <div className="about__image-placeholder">
                <div className="about__avatar">
                  <span className="about__avatar-text">AM</span>
                </div>
              </div>
              <div className="about__image-border" />
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
};

export default About;
