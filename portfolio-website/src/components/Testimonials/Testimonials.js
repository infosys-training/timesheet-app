import React from 'react';
import { motion } from 'framer-motion';
import { FiStar } from 'react-icons/fi';
import './Testimonials.css';

const Testimonials = () => {
  const testimonials = [
    {
      name: 'Sarah Chen',
      role: 'Product Manager, TechVision Labs',
      text: 'Alex is one of the most talented UI developers I\'ve ever worked with. Their attention to detail and ability to translate complex designs into flawless, performant code is remarkable. They consistently deliver ahead of schedule while maintaining the highest quality standards.',
      rating: 5,
    },
    {
      name: 'Marcus Johnson',
      role: 'CTO, Nexus Digital',
      text: 'Working with Alex transformed our frontend architecture. They introduced modern patterns and best practices that improved our development velocity by 40%. Their leadership in building our design system was instrumental to our company\'s growth.',
      rating: 5,
    },
    {
      name: 'Emily Rodriguez',
      role: 'Lead Designer, PixelCraft Agency',
      text: 'As a designer, finding a developer who truly understands design intent is rare. Alex bridges the gap between design and development seamlessly. Every component they build is pixel-perfect and accessibility-compliant.',
      rating: 5,
    },
    {
      name: 'David Kim',
      role: 'Engineering Director, CloudScale',
      text: 'Alex\'s expertise in performance optimization is outstanding. They reduced our application\'s load time by 60% and implemented monitoring systems that keep our platform running smoothly for millions of users.',
      rating: 5,
    },
  ];

  return (
    <section className="testimonials section" id="testimonials">
      <div className="container">
        <h2 className="section-heading">
          <span className="number">05.</span> What People Say
        </h2>
        <div className="testimonials__grid">
          {testimonials.map((testimonial, index) => (
            <motion.div
              key={testimonial.name}
              className="testimonials__card"
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: index * 0.15 }}
            >
              <div className="testimonials__stars">
                {Array.from({ length: testimonial.rating }).map((_, i) => (
                  <FiStar key={`star-${testimonial.name}-${i}`} className="testimonials__star" />
                ))}
              </div>
              <p className="testimonials__text">"{testimonial.text}"</p>
              <div className="testimonials__author">
                <div className="testimonials__avatar">
                  {testimonial.name.split(' ').map(n => n[0]).join('')}
                </div>
                <div>
                  <p className="testimonials__name">{testimonial.name}</p>
                  <p className="testimonials__role">{testimonial.role}</p>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default Testimonials;
