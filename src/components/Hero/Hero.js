import React from 'react';
import { Link } from 'react-scroll';
import { motion } from 'framer-motion';
import { FiGithub, FiLinkedin, FiTwitter, FiCodepen } from 'react-icons/fi';
import './Hero.css';

const Hero = () => {
  return (
    <section className="hero section" id="hero">
      <div className="hero__side-social">
        <a href="https://github.com" target="_blank" rel="noopener noreferrer" aria-label="GitHub">
          <FiGithub />
        </a>
        <a href="https://linkedin.com" target="_blank" rel="noopener noreferrer" aria-label="LinkedIn">
          <FiLinkedin />
        </a>
        <a href="https://twitter.com" target="_blank" rel="noopener noreferrer" aria-label="Twitter">
          <FiTwitter />
        </a>
        <a href="https://codepen.io" target="_blank" rel="noopener noreferrer" aria-label="CodePen">
          <FiCodepen />
        </a>
        <div className="hero__side-line" />
      </div>

      <div className="hero__side-email">
        <a href="mailto:alex.morgan@email.com">alex.morgan@email.com</a>
        <div className="hero__side-line" />
      </div>

      <div className="container hero__content">
        <motion.p
          className="hero__greeting"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1 }}
        >
          Hi, my name is
        </motion.p>
        <motion.h1
          className="hero__name"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.2 }}
        >
          Alex Morgan.
        </motion.h1>
        <motion.h2
          className="hero__tagline"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.3 }}
        >
          I craft exceptional digital experiences.
        </motion.h2>
        <motion.p
          className="hero__description"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.4 }}
        >
          I'm a senior UI developer specializing in building pixel-perfect, accessible,
          and performant web applications. Currently focused on creating immersive
          user experiences at{' '}
          <a href="#about" className="hero__highlight">TechVision Labs</a>.
        </motion.p>
        <motion.div
          className="hero__cta"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.5 }}
        >
          <Link to="projects" smooth duration={500} offset={-70} className="btn btn-filled">
            View My Work
          </Link>
          <Link to="contact" smooth duration={500} offset={-70} className="btn">
            Get In Touch
          </Link>
        </motion.div>
      </div>
    </section>
  );
};

export default Hero;
